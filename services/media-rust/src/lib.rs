//! Specter media relay (WebTransport SFU). `main.rs` only sets up logging
//! and calls [`run`]; everything else lives in this library so it can be
//! tested (`cargo test` runs the unit tests below and `tests/`).

pub mod config;
pub mod drain;
pub mod heartbeat;
pub mod nats;
pub mod netdiag; // server-assisted network diagnosis (Repair panel)
pub mod share_audio;
pub mod ticket;

use wtransport::{Endpoint, ServerConfig, Identity};
use log::{info, error, warn, debug};
use anyhow::Context as _;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc, watch};
use std::collections::{HashMap, HashSet};
use std::env;
use serde::Serialize;
use futures::StreamExt;
use prost::Message as _;
use sysinfo::System;

pub mod proto {
    pub mod specter {
        pub mod v1 {
            include!(concat!(env!("OUT_DIR"), "/specter.v1.rs"));
        }
    }
}

use crate::nats::Command;
use crate::ticket::{Claims, TicketVerifier};
use crate::share_audio::{ShareAudioDelivery, ShareAudioRateLimiter, ShareAudioTx, MAX_SHARE_AUDIO_AGE, SHARE_AUDIO_DGRAM_CAPABLE};

/// Per-process state every connection handler needs: the node identity
/// (usage events carry it, and session_end is published on a node-scoped
/// subject), the media ticket verifier, and the video session registry
/// drain_org closes.
pub struct NodeContext {
    pub node_id: String,
    pub session_end_subject: String,
    pub verifier: TicketVerifier,
    pub video_sessions: VideoRegistry,
}

type VideoRegistry = Arc<drain::VideoSessionRegistry<wtransport::Connection>>;

/// A delta (non-keyframe) video chunk older than this by the time a subscriber's
/// relay task gets to it is dropped rather than written. Without this, a
/// subscriber whose stream write is stalling (slow/congested downlink) just
/// silently backs up in the broadcast channel until it overflows (512 frames,
/// ~20s at 24fps) and only then resyncs — this bounds that worst case to a
/// fraction of a second, mirroring the outgoing-audio-queue max-age bound.
const MAX_VIDEO_FRAME_AGE: Duration = Duration::from_millis(300);

/// Bit 0 of a video frame's flags byte: 0 = keyframe, 1 = delta. The rest of
/// the byte carries flags that are none of this relay's business (bit 1 is the
/// client's end-to-end encryption marker — see FRAME_FLAG_ENCRYPTED in
/// CommLink.jsx), so keyframe tests must mask rather than compare the whole
/// byte. They used to compare it against 0x00 outright, which silently turned
/// "keyframe" into "keyframe AND no other flag set": the keyframe cache would
/// never populate and `needs_keyframe` would never clear, dropping every frame
/// for every subscriber the moment any other flag appeared.
const VIDEO_FLAG_DELTA: u8 = 0x01;

/// True if this frame's flags byte marks a keyframe. `flags` is the first byte
/// of the frame body (`[1B flags][4B ts][payload]`).
#[inline]
fn video_flags_is_keyframe(flags: u8) -> bool {
    flags & VIDEO_FLAG_DELTA == 0
}

/// Bit 2 of the flags byte: this share-stream frame is screen-share AUDIO
/// (an E2E-encrypted Opus packet), not video — see web-portal/src/engine/
/// shareAudio.js. Audio frames also set bit 0 (delta), so the keyframe tests
/// above already never treat them as keyframes, on this server or an older one.
///
/// Shipped (2.0.x) viewers parse the flags byte as `== 0 ? key : delta` and
/// would feed an audio frame to their video decoder, so audio is forwarded
/// ONLY to subscribers that asked for it (`share_audio=1` on the subscribe
/// URL), and a publisher only sends audio once this server has told it so
/// (SHARE_AUDIO_CAPABLE). The payload stays opaque here like video's.
/// Newer clients send and receive the same bytes as datagrams instead. The
/// relay converts between the two forms (see share_audio.rs).
const SHARE_FRAME_FLAG_AUDIO: u8 = 0x04;

/// True if this frame's flags byte marks a share-audio frame.
#[inline]
fn share_frame_is_audio(flags: u8) -> bool {
    flags & SHARE_FRAME_FLAG_AUDIO != 0
}

/// Server → publisher, a one-byte uni stream at the start of every publish
/// session (same shape as 0xAC/0xDE/VIDEO_KEYFRAME_REQUEST): "this server
/// filters share audio by subscriber capability, you may send it". Every
/// shipped publisher ignores signal bytes it doesn't know.
const SHARE_AUDIO_CAPABLE: u8 = 0x41;

/// One active sharer's relay channels: video frames, and share audio (in its
/// in-stream frame form, whether it arrived in-stream or as a datagram; see
/// share_audio.rs). Audio has its own channel so a subscriber can take it on a
/// path that never waits behind a video write.
#[derive(Clone)]
pub struct ShareStreamTx {
    pub video: broadcast::Sender<(bytes::Bytes, Instant)>,
    pub audio: ShareAudioTx,
}

/// Keyframe request, one byte, in both directions:
///   viewer → server     a datagram on the viewer's video subscribe session
///   server → publisher  a one-byte uni stream on the publish session, the
///                       same shape as the 0xAC/0xDE activation signals
/// Backward compatible both ways: a 2.0.x publisher reads the first byte of
/// every server uni stream and ignores anything that isn't 0xAC/0xDE (so it
/// keeps its plain 2 s GOP), and a 2.0.x viewer simply never sends one. An
/// older server never reads subscribe-session datagrams, so a new viewer's
/// request is dropped there and it waits for the scheduled keyframe as before.
const VIDEO_KEYFRAME_REQUEST: u8 = 0x4B;

/// At most one forced keyframe per sharer per this interval, however many
/// viewers ask. A keyframe is several times the size of a delta, so without
/// this one viewer on a bad link (resyncing every few hundred ms) would make
/// the stream keyframe-heavy — and costlier — for everyone watching it.
/// Requests arriving inside the window are coalesced into one sent at its end
/// (unless a keyframe answers them first).
const KEYFRAME_REQUEST_MIN_INTERVAL: Duration = Duration::from_millis(400);

/// A new subscriber gets the cached keyframe followed by live frames from the
/// moment it subscribed — the deltas in between are lost, so the picture is
/// only clean if the cached keyframe is (nearly) the latest frame. Older than
/// this (a couple of frame periods), ask the sharer for a fresh one.
const KEYFRAME_CACHE_FRESH: Duration = Duration::from_millis(100);

/// Queue depth per sharer for pending keyframe requests. Overflow is harmless:
/// a full queue already guarantees a forced keyframe is on its way.
const KEYFRAME_REQUEST_QUEUE: usize = 16;

#[derive(Debug, PartialEq, Eq)]
enum KeyframeGateDecision {
    /// A keyframe arrived after the newest pending request — nothing to do.
    AlreadySatisfied,
    /// Forward a request to the publisher now.
    ForwardNow,
    /// Rate-limited: re-decide at this instant.
    WaitUntil(Instant),
}

/// The per-sharer coalescing/rate-limit policy for keyframe requests. Pure
/// (all times are passed in) so it can be unit-tested; the I/O around it is
/// run_keyframe_request_relay.
struct KeyframeRequestGate {
    min_interval: Duration,
    last_forwarded: Option<Instant>,
}

impl KeyframeRequestGate {
    fn new(min_interval: Duration) -> Self {
        Self { min_interval, last_forwarded: None }
    }

    /// `newest_request`: when the most recent still-pending request was made.
    /// `last_keyframe`: when the sharer's most recent keyframe reached the
    /// server. A keyframe newer than every pending request answers all of them
    /// (each requester's relay will deliver it), whether it was forced or
    /// scheduled.
    fn decide(&self, newest_request: Instant, last_keyframe: Option<Instant>, now: Instant) -> KeyframeGateDecision {
        if last_keyframe.is_some_and(|kf| kf >= newest_request) {
            return KeyframeGateDecision::AlreadySatisfied;
        }
        if let Some(prev) = self.last_forwarded {
            let next_allowed = prev + self.min_interval;
            if now < next_allowed {
                return KeyframeGateDecision::WaitUntil(next_allowed);
            }
        }
        KeyframeGateDecision::ForwardNow
    }

    fn mark_forwarded(&mut self, now: Instant) {
        self.last_forwarded = Some(now);
    }
}

/// Codec extradata (SPS/PPS or equivalent) is a few hundred bytes to a few KB
/// at most; this is a generous ceiling that exists only so a publisher can't
/// send a bogus 4-byte length prefix (e.g. 0xFFFFFFFF) and make the server
/// attempt a multi-gigabyte allocation before reading a single header byte.
const MAX_VIDEO_HEADER_LEN: usize = 65_536;

/// Bounds how often an authenticated publisher can send a near-max-size video
/// frame. A single 1080p IDR keyframe legitimately brushes this size
/// occasionally, but sustained repeats have no legitimate encoder reason —
/// without this, a compromised/malicious publisher could sustain repeated
/// 25MB allocations indefinitely (the single-frame cap alone doesn't bound
/// the rate).
const LARGE_VIDEO_FRAME_THRESHOLD: usize = 5_000_000;
const MAX_LARGE_VIDEO_FRAMES_PER_WINDOW: u32 = 10;
const LARGE_VIDEO_FRAME_WINDOW: Duration = Duration::from_secs(5);

/// Monotonically increasing counter used to generate unique per-join nonces.
/// Compared inside the rooms write-lock to detect whether a new session has
/// already re-inserted a user before the old session's cleanup fires.
static SESSION_NONCE: AtomicUsize = AtomicUsize::new(1);

// ── Roster message types sent over unidirectional streams ─────────────────────
#[derive(Clone, Serialize)]
#[serde(tag = "type", content = "data")]
pub enum RosterMessage {
    Snapshot(Vec<String>),
    Sharers(Vec<String>), // active sharer callsigns on join
    Join(String),
    Leave { callsign: String, user_id: String },
    Move(String), // new_channel_id
    Speaking { callsign: String, level: u8 },
    /// ssrc -> user_id for every current room member, computed via canonical_ssrc.
    /// Sent as an initial snapshot on join and re-broadcast whenever membership
    /// changes, since a client can't independently recompute another user's ssrc
    /// (it only knows their callsign, not their true user_id) — this is the
    /// authoritative mapping relay-mode clients use to attribute an incoming
    /// lane's ssrc to a real speaker (UI labeling, per-lane mute, evidence-clip
    /// attribution). Carries no effect in mixed-mode rooms, where every audio
    /// datagram is still server-mixed to ssrc=0 regardless.
    SsrcMap(HashMap<u32, String>),
    /// Relay-mode ducking signal (see the "Priority ducking" section of the
    /// audio datagram relay path below) — server can no longer scale ciphertext
    /// gain itself once it never decodes audio, so it tells clients who's
    /// active and at what tier and each client applies the duck locally to
    /// every lane except the active speaker's own. `ssrc` lets a client
    /// identify "is this me" without a user_id round-trip. `level` mirrors the
    /// proto's PriorityLevel tiers (1 = PRIORITY_GLOBAL_ADMIN/-MAX dB, 2 =
    /// PRIORITY_GROUP_LEADER/-20dB) for differentiated duck depth.
    Duck { ssrc: u32, level: u8 },
    DuckRelease,
}

// ── Room state ─────────────────────────────────────────────────────────────────
pub struct RoomState {
    pub roster_tx: broadcast::Sender<String>,
    pub members: HashSet<String>,
    /// Maps user_id -> callsign for display in roster messages.
    pub callsigns: HashMap<String, String>,
    /// Per-user audio gain: 1.0 = normal, 0.1 = ducked, 0.0 = server-muted.
    pub user_gains: HashMap<String, f32>,
    /// Per-user mic activation threshold (raw i16 PCM RMS). The mixer only
    /// forwards a sender's audio once their RMS clears this value. Defaults to
    /// 150.0; user-adjustable client-side via a SET_AUDIO_THRESHOLD (0x05)
    /// control datagram.
    pub user_audio_thresholds: HashMap<String, f32>,
    /// Per-listener local mute: listener_user_id -> set of speaker user_ids they've
    /// chosen not to hear. Purely a personal listening preference — the mixer skips
    /// a muted speaker only when composing THAT listener's mix (main.rs mixer_task),
    /// so it has no effect on what anyone else hears. Set via a SET_LOCAL_MUTE (0x06)
    /// control datagram from the listener's own session.
    pub local_mutes: HashMap<String, HashSet<String>>,
    /// Users whose role grants priority (Commander/Squad-Leader-tier) -> their
    /// tier (1 or 2), set on join from the JWT's priority_level claim. Widened
    /// from a HashSet<String> (a bare "is this user priority" flag) so relay-mode
    /// ducking can drive differentiated duck depth per the proto's PriorityLevel
    /// tiers (PRIORITY_GLOBAL_ADMIN vs PRIORITY_GROUP_LEADER) instead of treating
    /// every priority speaker the same.
    pub priority_levels: HashMap<String, u8>,
    /// user_id of the currently active priority speaker (if any).
    pub priority_speaker: Option<String>,
    /// Instant at which ducking should be released.
    pub priority_release_at: Option<Instant>,
    /// Relay-mode only: last time an audio datagram arrived from each priority
    /// user — the packet-arrival "are they still talking" signal that replaces
    /// mixer_task's RMS-based is_speaking() check, which requires plaintext PCM
    /// the relay path never has. Not used/populated for Mixed rooms, which keep
    /// mixer_task's existing RMS-based detection unchanged.
    pub last_priority_packet_at: HashMap<String, Instant>,
    /// Sender half of the PCM ingress channel — cloned per user session.
    /// Dropped when RoomState is dropped, causing the mixer task to exit.
    pub pcm_tx: mpsc::Sender<(String, Vec<i16>)>,
    /// Per-user Opus-encoded output channels. The mixer writes here; each session
    /// loop reads its own receiver and writes datagrams to the client.
    pub user_output_senders: Arc<RwLock<HashMap<String, mpsc::Sender<Box<[u8]>>>>>,
    /// Small room-wide control channel: sharer join/leave announces, viewer-count
    /// updates. Kept separate from the per-sharer video byte streams below so that
    /// every room member (not just active video viewers) doesn't have to receive
    /// and discard every video frame from every active sharer just to catch these
    /// tiny, infrequent control pings — see video_streams doc comment.
    pub video_ctrl_tx: broadcast::Sender<bytes::Bytes>,
    /// Per-sharer screen-share video relay: user_id -> broadcast channel of that
    /// sharer's (raw_chunk_bytes, produced_at). Created when a sharer starts
    /// publishing, removed when they stop. One channel per sharer (rather than one
    /// shared room-wide channel all sharers write into) so that: (1) a subscriber
    /// watching one specific sharer only ever wakes for that sharer's frames
    /// instead of receiving and discarding every other active sharer's frames too,
    /// and (2) each sharer gets its own full 512-frame buffer instead of competing
    /// for a shared ring buffer with every other concurrent sharer in the room —
    /// with many simultaneous sharers the old shared-channel design meant more
    /// sharers directly shrank everyone's effective buffer, causing more frequent
    /// Lagged/keyframe-resync events exactly when the room is busiest.
    pub video_streams: Arc<RwLock<HashMap<String, ShareStreamTx>>>,
    /// Number of users currently subscribed to watch the active screen share.
    pub video_viewer_count: Arc<AtomicU32>,
    /// All users currently sharing their screen: user_id -> callsign.
    pub video_sharers: Arc<RwLock<HashMap<String, String>>>,
    /// Cached stream header per active sharer: user_id -> [4B len][header JSON].
    /// Replayed to subscribers that join after the stream has already started.
    pub video_headers: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    /// Most recent keyframe per active sharer: user_id -> (framed keyframe
    /// packet, when it arrived). Sent to subscribers immediately after the
    /// header so VideoDecoder gets a sync point without waiting up to 2 s for
    /// the next periodic keyframe. The arrival time lets a new subscriber tell
    /// whether that keyframe is still current (KEYFRAME_CACHE_FRESH) and lets
    /// the keyframe-request relay skip requests a keyframe already answered.
    pub video_keyframes: Arc<RwLock<HashMap<String, (Vec<u8>, Instant)>>>,
    /// Per active sharer: user_id -> the queue of that sharer's keyframe
    /// requests (each the Instant it was made). Anything that needs the
    /// sharer's next frame to be a keyframe — a viewer's request datagram, a
    /// subscriber relay that just dropped frames, a new subscriber with a
    /// stale cached keyframe — pushes onto it; run_keyframe_request_relay
    /// coalesces them into at most one forced keyframe per
    /// KEYFRAME_REQUEST_MIN_INTERVAL. Registered/removed alongside
    /// video_activation_senders (same nonce-gated lifetime).
    pub video_keyframe_requests: Arc<RwLock<HashMap<String, mpsc::Sender<Instant>>>>,
    /// Per-sharer viewer count watch channels.  Publisher task watches this to
    /// know when to activate (first viewer) or deactivate (last viewer leaves).
    /// Subscriber tasks increment on connect and decrement on disconnect.
    pub video_activation_senders: Arc<RwLock<HashMap<String, watch::Sender<u32>>>>,
    /// Per-user join nonce (from SESSION_NONCE counter).  Used by cleanup to
    /// detect whether a new session has already reclaimed the user's room slot
    /// before the old session's cleanup task runs.  Cleanup is skipped if the
    /// nonce no longer matches (i.e. a new session re-joined first).
    pub session_nonces: HashMap<String, usize>,
    /// Same reconnect-race protection as session_nonces above, but for video
    /// publish sessions: user_id -> nonce of the currently-live publish task.
    /// Without this, a publisher's reconnect (old session's cleanup racing the
    /// new session's registration) could wipe the new session's video_headers/
    /// video_keyframes/video_streams/video_sharers/video_activation_senders
    /// entries and falsely broadcast "sharer left". Arc<RwLock<..>> (rather than
    /// plain HashMap like session_nonces) to match how the other video_* maps
    /// on this struct are accessed — cloned out once in handle_video_publish
    /// rather than reached via a held room_registry write lock.
    pub video_publish_nonces: Arc<RwLock<HashMap<String, usize>>>,
    /// user_id -> org_id, captured from the JWT at join time. Lets a drain/kick
    /// operation be scoped to one org (e.g. during a node migration) without
    /// evicting a user's session in an unrelated org that happens to share this
    /// same node/room registry.
    pub member_orgs: HashMap<String, String>,
    /// Decided once from the first joiner's `voice_relay` JWT claim (identity-node's
    /// getOrgToken, itself sourced from channels.voice_relay_mode — see migration
    /// 000059) and fixed for the room's lifetime: every later joiner's own claim must
    /// agree or their connection is rejected (see the check at room-join, mirroring
    /// the existing token_channel_id check). false = today's server-mixed TLS-only
    /// voice (mixer_task). true = per-sender SFrame-encrypted relay — audio datagrams
    /// are forwarded opaquely (ssrc rewritten from the authenticated session, never
    /// decoded) instead of being decoded/mixed/re-encoded, and no mixer_task is
    /// spawned for this room at all.
    /// E2EV (2.0.0): always true — handle_voice_connection rejects every
    /// ticket without voice_relay=true and a signed client_version >= the
    /// minimum, so mixed rooms can no longer be created.
    pub voice_relay_mode: bool,
}

// ── Registry type aliases ──────────────────────────────────────────────────────
type SessionRegistry = Arc<RwLock<HashMap<String, broadcast::Sender<()>>>>;
/// Per-session move-command channel: carries the new channel_id to the session loop.
type MoveRegistry   = Arc<RwLock<HashMap<String, mpsc::Sender<String>>>>;
type RoomRegistry   = Arc<RwLock<HashMap<String, RoomState>>>;

// ── Event channel tree (hierarchy routing) ─────────────────────────────────────
#[derive(Clone)]
struct ChannelTreeNode {
    parent_id: Option<String>,
    tier: u8,
    leader_user_id: Option<String>,
}
type ChannelTreeRegistry = Arc<RwLock<HashMap<String, ChannelTreeNode>>>;

/// Collect all descendant channel_ids from a root channel. Iterative with a
/// visited set so a malformed or cyclic tree — a bad upstream payload from
/// identity-node, or a spoofed NATS message if the bus isn't yet
/// authenticated (see NATS_AUTH_TOKEN) — can't stack-overflow this process;
/// a cycle just stops expanding once every node in it has been visited once.
fn get_descendants(tree: &HashMap<String, ChannelTreeNode>, root: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut visited: HashSet<String> = HashSet::new();
    let mut frontier: Vec<String> = vec![root.to_string()];

    while let Some(current) = frontier.pop() {
        for (id, node) in tree {
            if node.parent_id.as_deref() == Some(current.as_str()) && visited.insert(id.clone()) {
                result.push(id.clone());
                frontier.push(id.clone());
            }
        }
    }
    result
}

// ── Voice Activity Detection ───────────────────────────────────────────────────
fn is_speaking(pcm: &[i16], threshold: f32) -> bool {
    if pcm.is_empty() { return false; }
    let rms = (pcm.iter()
        .map(|&s| (s as f64).powi(2))
        .sum::<f64>() / pcm.len() as f64)
        .sqrt();
    rms > threshold as f64
}

// Returns a 0–100 level from PCM samples (maps RMS 0–8000 to 0–100).
fn compute_level(pcm: &[i16]) -> u8 {
    if pcm.is_empty() { return 0; }
    let n = pcm.len().min(960);
    let rms = (pcm[..n].iter()
        .map(|&s| (s as f64).powi(2))
        .sum::<f64>() / n as f64)
        .sqrt();
    ((rms / 8000.0 * 100.0).min(100.0)) as u8
}

/// Bit-exact port of CommLink.jsx's `hashUserId` (a standard 32-bit string hash,
/// `hash = hash*31 + charCode` done via shift-sub, JS-int32-wrapped each step,
/// then `Math.abs(...) >>> 0`). Used in relay mode to rewrite a client's
/// self-asserted `ssrc` to a value derived from their *authenticated* user_id
/// before forwarding — see the audio relay path below — so a legitimate
/// client's own value passes through unchanged (client and server compute the
/// same hash) while a spoofed one gets corrected. Assumes user_id is ASCII
/// (true for this app's UUIDs): JS iterates UTF-16 code units, Rust iterates
/// Unicode scalar values, and those coincide for ASCII input.
fn canonical_ssrc(user_id: &str) -> u32 {
    let mut hash: i32 = 0;
    for c in user_id.chars() {
        hash = hash.wrapping_shl(5).wrapping_sub(hash).wrapping_add(c as i32);
    }
    hash.unsigned_abs()
}

/// E2EV: level reported in relay-mode Speaking messages (0–100 scale).
const RELAY_SPEAKING_LEVEL: u8 = 50;

// ── E2EV: minimum client version for (relay-only) voice ───────────────────────
/// Same default and env override as identity-node's voiceClientGate.ts.
fn min_relay_client_version() -> String {
    std::env::var("MIN_RELAY_CLIENT_VERSION")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "2.0.0".to_string())
}

/// "MAJOR.MINOR.PATCH" with optional leading 'v' and ignored -pre/+build suffix.
fn parse_semver(v: &str) -> Option<(u64, u64, u64)> {
    let v = v.trim();
    let v = v.strip_prefix('v').unwrap_or(v);
    let core = v.split(|c| c == '-' || c == '+').next()?;
    let mut it = core.split('.');
    let a = it.next()?.parse().ok()?;
    let b = it.next()?.parse().ok()?;
    let c = it.next()?.parse().ok()?;
    if it.next().is_some() { return None; }
    Some((a, b, c))
}

/// Mission Wide: a voice ticket carrying `listen_only: true` joins its room
/// receive-only. The session's audio datagrams (and share announces) are
/// dropped, never forwarded, so a non-commander can't talk on the event's
/// one-way broadcast room even with a hand-built client. Absent / non-bool /
/// false = a normal two-way session (every ticket minted before this claim).
fn ticket_listen_only(claims: &Claims) -> bool {
    claims.get("listen_only").and_then(|v| v.as_bool()).unwrap_or(false)
}

fn client_version_ok(claimed: &str) -> bool {
    match (parse_semver(claimed), parse_semver(&min_relay_client_version())) {
        (Some(have), Some(need)) => have >= need,
        _ => false,
    }
}

/// Relay-mode counterpart to mixer_task's per-tick release check: since a
/// relay-mode room has no mixer loop to piggyback on, this is a standalone
/// task (one per relay-mode room, spawned alongside room creation) that just
/// checks whether the active priority speaker's 1500ms hangover has elapsed.
/// Self-terminates once the room is gone from the registry (members.is_empty()
/// cleanup removes the whole RoomState — see the session cleanup block).
async fn duck_release_sweeper(room_id: String, rooms: RoomRegistry) {
    let mut interval = tokio::time::interval(Duration::from_millis(250));
    loop {
        interval.tick().await;
        let mut rooms_lock = rooms.write().await;
        let state = match rooms_lock.get_mut(&room_id) {
            Some(s) => s,
            None => break,
        };
        if let Some(release_at) = state.priority_release_at {
            if Instant::now() >= release_at {
                state.priority_speaker = None;
                state.priority_release_at = None;
                let msg = serde_json::to_string(&RosterMessage::DuckRelease).unwrap();
                let _ = state.roster_tx.send(msg);
            }
        }
    }
}

// ── Per-room mixer task ────────────────────────────────────────────────────────
async fn mixer_task(
    room_id: String,
    rooms: RoomRegistry,
    mut pcm_rx: mpsc::Receiver<(String, Vec<i16>)>,
    user_senders: Arc<RwLock<HashMap<String, mpsc::Sender<Box<[u8]>>>>>,
    nats: Option<async_nats::Client>,
    channel_tree: ChannelTreeRegistry,
) {
    let mut interval = tokio::time::interval(Duration::from_millis(20));
    let mut pcm_buffers: HashMap<String, Vec<i16>> = HashMap::new();
    let mut encoders: HashMap<String, audiopus::coder::Encoder> = HashMap::new();
    let mut broadcast_encoder: Option<audiopus::coder::Encoder> = None;
    let mut mix_frame_counter: u64 = 0;
    let mut prev_speaking: HashMap<String, bool> = HashMap::new();
    // Last mix_frame_counter tick at which each sender's raw RMS cleared their
    // threshold — drives the hangover gate below.
    let mut last_speaking_frame: HashMap<String, u64> = HashMap::new();
    // 200ms hold after a sender's RMS dips below threshold before their audio
    // is actually dropped from recipients' mixes. Without this, a static
    // per-20ms RMS gate cuts real speech constantly (soft consonants, breath
    // pauses, brief mid-word dips all read as "not speaking" for a single
    // 20ms window) — audible as words cutting in and out. This doesn't relax
    // *what* gets mixed, just extends the window a sender is considered
    // "active" so trailing/leading quiet parts of real speech pass through.
    const VAD_HANGOVER_FRAMES: u64 = 10;

    info!("Mixer task started for room: {}", room_id);

    loop {
        interval.tick().await;
        mix_frame_counter += 1;

        // ── Drain incoming decoded PCM ─────────────────────────────────────
        let mut disconnected = false;
        loop {
            match pcm_rx.try_recv() {
                Ok((uid, pcm)) => { pcm_buffers.entry(uid).or_default().extend(pcm); }
                Err(mpsc::error::TryRecvError::Empty) => break,
                Err(mpsc::error::TryRecvError::Disconnected) => { disconnected = true; break; }
            }
        }
        if disconnected {
            info!("Mixer PCM channel closed — room {} disposed.", room_id);
            break;
        }

        // ── Priority ducking logic ─────────────────────────────────────────
        // Fast path: most rooms have no priority/dispatcher users and are not
        // currently ducked, so skip the write lock entirely in that case. A
        // shared read lock lets every other room's mixer tick proceed
        // concurrently instead of serializing all rooms' mixer loops against
        // each other on every 20ms tick.
        let needs_ducking_work = {
            let rooms_lock = rooms.read().await;
            match rooms_lock.get(&room_id) {
                Some(state) => !state.priority_levels.is_empty() || state.priority_speaker.is_some(),
                None => break,
            }
        };

        let mut cross_channel_speaker: Option<String> = None;
        if needs_ducking_work {
            let mut rooms_lock = rooms.write().await;
            let state = match rooms_lock.get_mut(&room_id) {
                Some(s) => s,
                None => break,
            };

            let mut found_speaker: Option<String> = None;
            for uid in state.priority_levels.keys() {
                if let Some(pcm) = pcm_buffers.get(uid) {
                    if is_speaking(pcm, 500.0) { found_speaker = Some(uid.clone()); break; }
                }
            }

            if let Some(ref speaker_id) = found_speaker {
                let is_newly_ducking = state.priority_speaker.is_none();
                state.priority_speaker = Some(speaker_id.clone());
                state.priority_release_at = Some(Instant::now() + Duration::from_millis(1500));

                let priority_snap: HashSet<String> = state.priority_levels.keys().cloned().collect();
                for (uid, gain) in state.user_gains.iter_mut() {
                    if !priority_snap.contains(uid) && *gain > 0.0 { *gain = 0.1; }
                }

                if is_newly_ducking {
                    if let Some(ref n) = nats {
                        let payload = format!(
                            r#"{{"channel_id":"{}","priority_user":"{}","action":"duck"}}"#,
                            room_id, speaker_id
                        );
                        let _ = n.publish(
                            crate::nats::duck_subject(&room_id),
                            bytes::Bytes::from(payload),
                        ).await;
                    }
                }

                cross_channel_speaker = Some(speaker_id.clone());
            }

            if let Some(release_at) = state.priority_release_at {
                if Instant::now() >= release_at {
                    for gain in state.user_gains.values_mut() {
                        if (*gain - 0.1_f32).abs() < 1e-4 { *gain = 1.0; }
                    }
                    state.priority_speaker    = None;
                    state.priority_release_at = None;
                }
            }

            // ── Cross-channel cascading duck (separate borrow from state) ──
            if let Some(ref speaker_id) = cross_channel_speaker {
                let tree = channel_tree.read().await;
                let descendants = get_descendants(&tree, &room_id);
                drop(tree);
                for desc_id in &descendants {
                    if let Some(desc_state) = rooms_lock.get_mut(desc_id) {
                        for (_uid, gain) in desc_state.user_gains.iter_mut() {
                            if *gain > 0.0 { *gain = 0.1; }
                        }
                        desc_state.priority_speaker = Some(speaker_id.clone());
                        desc_state.priority_release_at = Some(Instant::now() + Duration::from_millis(1500));
                    }
                }
            }
        }

        // ── Read current gain + audio-threshold + local-mute tables ──────────
        let (gains, thresholds, local_mutes) = {
            let rooms_lock = rooms.read().await;
            match rooms_lock.get(&room_id) {
                Some(state) => (state.user_gains.clone(), state.user_audio_thresholds.clone(), state.local_mutes.clone()),
                None => break,
            }
        };

        // ── Per-sender speaking gate (computed once per tick, with hangover) ──
        // Computed once per sender rather than per (recipient, sender) pair,
        // with a held "active" state rather than a hard cutoff, so a
        // momentary RMS dip mid-word doesn't gate the speaker closed.
        let mut sender_active: HashMap<String, bool> = HashMap::new();
        for (sender_id, buffer) in &pcm_buffers {
            let n = buffer.len().min(960);
            let threshold = thresholds.get(sender_id).copied().unwrap_or(150.0);
            if n > 0 && is_speaking(&buffer[..n], threshold) {
                last_speaking_frame.insert(sender_id.clone(), mix_frame_counter);
            }
            let last = last_speaking_frame.get(sender_id).copied().unwrap_or(0);
            let within_hangover = last > 0 && mix_frame_counter.saturating_sub(last) <= VAD_HANGOVER_FRAMES;
            sender_active.insert(sender_id.clone(), within_hangover);
        }

        // ── Mix + encode + send ────────────────────────────────────────────
        let senders = user_senders.read().await;
        let user_ids: Vec<String> = senders.keys().cloned().collect();
        let empty_mute_set: HashSet<String> = HashSet::new();

        for recipient in &user_ids {
            let mut mixed = vec![0i32; 960]; // 20 ms @ 48 kHz mono
            let mut has_audio = false;
            let muted_by_recipient = local_mutes.get(recipient).unwrap_or(&empty_mute_set);

            for (sender_id, buffer) in &pcm_buffers {
                if sender_id == recipient { continue; }
                // Listener's own local-mute preference — excludes this sender from THEIR
                // mix only; every other recipient's mix is built independently and unaffected.
                if muted_by_recipient.contains(sender_id) { continue; }
                let gain = gains.get(sender_id).copied().unwrap_or(1.0);
                if gain == 0.0 { continue; }

                let n = buffer.len().min(960);
                // Noise gate with hangover (see sender_active above) — a sender stays
                // "active" for VAD_HANGOVER_FRAMES after their RMS last cleared
                // threshold, so brief mid-word dips don't chop real speech.
                if n == 0 || !*sender_active.get(sender_id).unwrap_or(&false) { continue; }

                for (i, &s) in buffer[..n].iter().enumerate() {
                    mixed[i] += (s as f32 * gain) as i32;
                }
                has_audio = true;
            }

            if !has_audio { continue; }

            // Log every ~5 seconds (250 × 20ms)
            if mix_frame_counter % 250 == 0 {
                info!("Mixer sending audio to {} (room {})", recipient, room_id);
            }

            let mixed_i16: Vec<i16> = mixed.iter()
                .map(|&s| s.clamp(-32_768, 32_767) as i16)
                .collect();

            // A creation failure here must not panic the whole mixer_task —
            // that would kill audio for every participant in the room, not
            // just this one recipient. Skip this recipient this tick instead.
            let encoder = match encoders.entry(recipient.clone()) {
                std::collections::hash_map::Entry::Occupied(e) => e.into_mut(),
                std::collections::hash_map::Entry::Vacant(e) => {
                    match audiopus::coder::Encoder::new(
                        audiopus::SampleRate::Hz48000,
                        audiopus::Channels::Mono,
                        audiopus::Application::Voip,
                    ) {
                        Ok(enc) => e.insert(enc),
                        Err(err) => {
                            warn!("Failed to create mixer Opus encoder for {}: {:?} — skipping this recipient this tick", recipient, err);
                            continue;
                        }
                    }
                }
            };

            let mut opus_buf = vec![0u8; 4000];
            let n = match encoder.encode(&mixed_i16, &mut opus_buf) {
                Ok(n) => n,
                Err(e) => { warn!("Opus encode error in mixer for {}: {:?}", recipient, e); continue; }
            };

            let audio_frame = proto::specter::v1::AudioFrame {
                encrypted_payload: opus_buf[..n].to_vec(),
                ssrc:               0,
                sequence:           (mix_frame_counter & 0x7fff_ffff) as i32,
                is_global_broadcast: false,
                sender_signature:   vec![],
            };
            let frame_bytes = audio_frame.encode_to_vec();

            if let Some(tx) = senders.get(recipient) {
                let _ = tx.try_send(frame_bytes.into_boxed_slice());
            }
        }

        // ── Cross-channel priority broadcast to descendant channels ────────
        // When a priority speaker is active in this room, encode their audio
        // separately and send it to all sessions in descendant channels.
        {
            let active_speaker = {
                let rl = rooms.read().await;
                rl.get(&room_id).and_then(|s| s.priority_speaker.clone())
            };
            if let Some(ref speaker_id) = active_speaker {
                let tree = channel_tree.read().await;
                let descendants = get_descendants(&tree, &room_id);
                drop(tree);

                if !descendants.is_empty() {
                    if let Some(pcm) = pcm_buffers.get(speaker_id) {
                        let n_samples = pcm.len().min(960);
                        if n_samples > 0 {
                            // Same rationale as the per-recipient encoder above: a creation
                            // failure must not panic the mixer task via .expect(). Skip this
                            // tick's cross-channel broadcast instead of the whole room's audio.
                            if broadcast_encoder.is_none() {
                                match audiopus::coder::Encoder::new(
                                    audiopus::SampleRate::Hz48000,
                                    audiopus::Channels::Mono,
                                    audiopus::Application::Voip,
                                ) {
                                    Ok(enc) => broadcast_encoder = Some(enc),
                                    Err(err) => warn!("Failed to create broadcast Opus encoder: {:?} — skipping cross-channel broadcast this tick", err),
                                }
                            }
                            if let Some(enc) = broadcast_encoder.as_mut() {
                            // Opus requires an exact 960-sample (20 ms @ 48 kHz) frame —
                            // encoding a shorter slice (e.g. right as the speaker starts
                            // talking, before a full 20 ms window has accumulated) feeds
                            // the encoder a mismatched frame length, which is a known
                            // source of garbled/distorted output. The main per-recipient
                            // mix above already avoids this via a fixed-size buffer;
                            // this path didn't, and was the extreme-distortion source
                            // reported by users hearing a priority speaker cross-channel.
                            let mut frame_960 = vec![0i16; 960];
                            frame_960[..n_samples].copy_from_slice(&pcm[..n_samples]);
                            let mut opus_buf = vec![0u8; 4000];
                            if let Ok(n) = enc.encode(&frame_960, &mut opus_buf) {
                                let frame = proto::specter::v1::AudioFrame {
                                    encrypted_payload: opus_buf[..n].to_vec(),
                                    ssrc: 0,
                                    sequence: (mix_frame_counter & 0x7fff_ffff) as i32,
                                    is_global_broadcast: true,
                                    sender_signature: vec![],
                                };
                                let frame_bytes: Box<[u8]> = frame.encode_to_vec().into_boxed_slice();

                                let rooms_lock = rooms.read().await;
                                for desc_id in &descendants {
                                    if let Some(desc_room) = rooms_lock.get(desc_id) {
                                        let desc_senders = desc_room.user_output_senders.read().await;
                                        for (_, tx) in desc_senders.iter() {
                                            let _ = tx.try_send(frame_bytes.clone());
                                        }
                                    }
                                }
                            }
                            }
                        }
                    }
                }
            }
        }

        // ── Emit per-user speaking levels (every 5 frames = 100ms) ──────────
        if mix_frame_counter % 5 == 0 {
            let rooms_lock = rooms.read().await;
            if let Some(state) = rooms_lock.get(&room_id) {
                for (uid, pcm) in &pcm_buffers {
                    let speaking = is_speaking(pcm, 300.0);
                    let level = if speaking { compute_level(pcm) } else { 0u8 };
                    let prev = *prev_speaking.get(uid).unwrap_or(&false);
                    // Always emit when speaking to keep level bar animated; emit once on silence
                    if speaking || prev {
                        if let Some(callsign) = state.callsigns.get(uid) {
                            let msg = serde_json::to_string(&RosterMessage::Speaking {
                                callsign: callsign.clone(),
                                level,
                            }).unwrap_or_default();
                            if !msg.is_empty() { let _ = state.roster_tx.send(msg); }
                        }
                    }
                    prev_speaking.insert(uid.clone(), speaking);
                }
            }
        }

        // ── Drain consumed PCM buffers ─────────────────────────────────────
        for buffer in pcm_buffers.values_mut() {
            // Buffer bounding: trim to 2 frames (1920 samples = 40 ms) so a burst of
            // datagrams arriving at once does not introduce more than 40 ms of
            // mixer-side latency.  960 samples are then consumed for this tick.
            if buffer.len() > 1920 {
                let excess = buffer.len() - 1920;
                buffer.drain(..excess);
            }
            if buffer.len() >= 960 { buffer.drain(..960); }
            else { buffer.clear(); }
        }

        // ── Remove encoders for users who have left ────────────────────────
        encoders.retain(|uid, _| senders.contains_key(uid));
    }

    info!("Mixer task exiting for room: {}", room_id);
}

/// Load the WebTransport TLS identity. Both TLS_CERT and TLS_KEY set: load
/// them, and fail with a clear error (not a panic) if either can't be read —
/// a crash-looping relay with a bare `expect` backtrace is what a failed
/// certbot run used to produce (eval M2). Neither set: self-signed, dev only.
/// Only one of them set is a configuration error.
async fn load_tls_identity(cert: Option<String>, key: Option<String>) -> anyhow::Result<Identity> {
    // An empty value counts as set (and then fails to load) rather than
    // silently falling back to a self-signed cert.
    match (cert, key) {
        (Some(cert_path), Some(key_path)) => {
            info!("Loading TLS from {}, {}", cert_path, key_path);
            Identity::load_pemfiles(&cert_path, &key_path).await.with_context(|| format!(
                "cannot load the TLS certificate/key (TLS_CERT={}, TLS_KEY={}). Check that both files exist, \
                 are readable by this process and are PEM encoded (e.g. that certbot issued them)",
                cert_path, key_path
            ))
        }
        (None, None) => {
            warn!("TLS_CERT/TLS_KEY not set — using self-signed cert (dev only)");
            Identity::self_signed(["localhost", "127.0.0.1", "::1"]).context("cannot generate a self-signed TLS identity")
        }
        (Some(_), None) => anyhow::bail!("TLS_CERT is set but TLS_KEY is not — set both or neither"),
        (None, Some(_)) => anyhow::bail!("TLS_KEY is set but TLS_CERT is not — set both or neither"),
    }
}

/// Run the relay until the process is killed. Every configuration problem
/// that makes the relay unsafe or unusable is returned as an error before
/// anything is served; `main` logs it and exits non-zero.
pub async fn run() -> anyhow::Result<()> {
    // ── 0. Configuration ──────────────────────────────────────────────────────
    // Media tickets: ES256 with MEDIA_TICKET_PUBLIC_KEY and/or legacy HS256
    // with JWT_SECRET. Neither = refuse to start (no insecure default).
    let verifier = TicketVerifier::from_env().map_err(anyhow::Error::msg)?;
    if verifier.accepts_es256() {
        info!("Media tickets: ES256 accepted (kid {}, aud {})", ticket::MEDIA_TICKET_KID, ticket::MEDIA_TICKET_AUD);
    }
    if verifier.accepts_legacy_hs256() {
        warn!(
            "Media tickets: legacy HS256 accepted because JWT_SECRET is set. This node holds the platform's \
             master signing secret — once identity-node signs ES256 media tickets, remove JWT_SECRET here \
             and keep only MEDIA_TICKET_PUBLIC_KEY."
        );
    }

    let cfg = config::NodeConfig::from_env().map_err(anyhow::Error::msg)?;
    let node_id = cfg.node_id.id.clone();
    if cfg.node_id.legacy_default {
        warn!(
            "NODE_ID is not set — defaulting to '{}', prod node-1's id. Only prod node-1 may run like this, \
             and only until its compose sets NODE_ID. Any other relay on this default overwrites node-1's \
             entry in identity-node's node registry and steals its traffic.",
            node_id
        );
    }
    let region = cfg.region.clone();
    let nats_url = cfg.nats_url.clone();
    match &cfg.nats_auth {
        config::NatsAuth::None => {
            // Not fail-closed — NATS may still be loopback-only. But anyone who
            // can publish to specter.cmd.> can kick/mute/move/drain any user,
            // since handle_nats_commands trusts every message on that subject.
            warn!("No NATS credentials (NATS_CREDS / NATS_USER+NATS_PASSWORD / NATS_AUTH_TOKEN) — the NATS command bus is unauthenticated. Safe only while NATS is loopback-only.");
        }
        config::NatsAuth::Token(_) => {
            warn!("NATS: using the shared NATS_AUTH_TOKEN (legacy). Every holder of it can publish as any node; switch to a per-node NATS_USER/NATS_PASSWORD or NATS_CREDS.");
        }
        _ => {}
    }

    info!("Starting Specter Media SFU (WebTransport + Server-Side Mixing) as node '{}'...", node_id);

    let video_sessions: VideoRegistry = drain::VideoSessionRegistry::new();
    let node_ctx = Arc::new(NodeContext {
        node_id: node_id.clone(),
        session_end_subject: nats::session_end_subject(&node_id),
        verifier,
        video_sessions: video_sessions.clone(),
    });
    let drains = drain::DrainTracker::new();

    // ── 1. Connect to NATS ────────────────────────────────────────────────────
    info!("Connecting to NATS at {} ({})...", nats_url, cfg.nats_auth.describe());
    // Bounded retry: in auth-callout mode a relay that boots before
    // identity-node is serving the callout is refused at first, and without a
    // retry it would run with no heartbeat/commands until restarted. Not
    // async-nats' retry_on_initial_connect — that hands back a client that may
    // never connect, and publishes on it can block once its buffer fills.
    let mut nats_client = None;
    for attempt in 1..=6u32 {
        match nats::connect(&nats_url, &cfg.nats_auth, &node_id).await {
            Ok(client) => { info!("Connected to NATS!"); nats_client = Some(client); break; }
            Err(e) if attempt < 6 => {
                warn!("NATS connect attempt {}/6 failed ({}); retrying in {}s", attempt, e, attempt);
                tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
            }
            Err(e) => warn!("NATS unavailable ({}). Continuing without remote commands.", e),
        }
    }

    // ── 2. Registries ─────────────────────────────────────────────────────────
    let sessions: SessionRegistry  = Arc::new(RwLock::new(HashMap::new()));
    let move_senders: MoveRegistry = Arc::new(RwLock::new(HashMap::new()));
    let rooms: RoomRegistry        = Arc::new(RwLock::new(HashMap::new()));
    let channel_tree: ChannelTreeRegistry = Arc::new(RwLock::new(HashMap::new()));

    // ── 3. NATS command listener ───────────────────────────────────────────────
    if let Some(nats_clone) = nats_client.clone() {
        let sessions_clone     = sessions.clone();
        let rooms_clone        = rooms.clone();
        let move_senders_clone = move_senders.clone();
        let tree_clone         = channel_tree.clone();
        let video_clone        = video_sessions.clone();
        let drains_clone       = drains.clone();
        tokio::spawn(async move {
            handle_nats_commands(nats_clone, sessions_clone, rooms_clone, move_senders_clone, tree_clone, video_clone, drains_clone).await;
        });
    }

    // ── 3b. Backfill event tree from identity-node ─────────────────────────────
    // The tree above only starts empty and gets populated by live
    // specter.event.tree.> publishes — so a restart mid-event silently loses
    // ducking-cascade and leader dual-subscribe state for any channel not
    // re-published since. Request the current state at startup instead.
    // Spawned rather than awaited inline so a slow/absent responder never
    // delays the WebTransport listener from starting.
    //
    // Retried with backoff (not one-shot): identity-node and media-rust are
    // deployed together and can restart simultaneously (observed in
    // production), in which case a single immediate request can race
    // identity-node's own NATS responder registration and time out with
    // nothing to catch it. Retrying for a couple of minutes comfortably
    // covers even a slow identity-node boot (DB pool warmup, etc.).
    if let Some(nats_clone) = nats_client.clone() {
        let tree_clone = channel_tree.clone();
        tokio::spawn(async move {
            let delays = [1, 2, 5, 10, 15, 30, 30, 30];
            for (attempt, delay_secs) in delays.iter().enumerate() {
                match tokio::time::timeout(
                    Duration::from_secs(5),
                    nats_clone.request(nats::EVENT_TREE_REQUEST_SUBJECT, bytes::Bytes::new()),
                ).await {
                    Ok(Ok(reply)) => {
                        apply_channel_tree_payload(&tree_clone, &reply.payload).await;
                        info!("Event tree backfilled from identity-node on startup (attempt {})", attempt + 1);
                        return;
                    }
                    Ok(Err(e)) => warn!("Event tree backfill request failed (attempt {}): {}", attempt + 1, e),
                    Err(_) => warn!("Event tree backfill request timed out after 5s (attempt {})", attempt + 1),
                }
                tokio::time::sleep(Duration::from_secs(*delay_secs)).await;
            }
            error!("Event tree backfill gave up after {} attempts — tree stays empty until next live publish", delays.len());
        });
    }

    // ── 4. WebTransport server ────────────────────────────────────────────────
    let port: u16 = env::var("WEBTRANSPORT_PORT")
        .or_else(|_| env::var("PORT"))
        .unwrap_or_else(|_| "4433".to_string())
        .parse()
        .unwrap_or(4433);

    let identity = load_tls_identity(env::var("TLS_CERT").ok(), env::var("TLS_KEY").ok()).await?;

    // A closure (not a literal) so the alternate port below gets the exact
    // same settings.
    let make_server_config = |bind_port: u16| ServerConfig::builder()
        .with_bind_default(bind_port)
        .with_identity(&identity)
        // keep_alive_interval alone doesn't detect a dead peer — it only stops
        // this end from tripping its own idle timer. max_idle_timeout is what
        // actually closes the connection once a peer stops responding (a
        // crash/force-quit/network-drop/sleep never sends CONNECTION_CLOSE).
        // 10s sits comfortably above the 1s keep-alive cadence.
        .keep_alive_interval(Some(Duration::from_secs(1)))
        .max_idle_timeout(Some(Duration::from_secs(10)))
        .expect("valid idle timeout")
        .build();

    let server = Endpoint::server(make_server_config(port))?;
    info!("Listening on UDP :{}", port);

    // ── 4a. Alternate WebTransport port (WEBTRANSPORT_ALT_PORT, off when unset)
    // A second endpoint on another UDP port for networks that block QUIC on
    // 443 only. Same cert, same handle_connection, same auth: it just feeds
    // its own accept loop (section 6a below). Advertised in the heartbeat as
    // `alt_port` so identity-node can hand clients an alt_media_url.
    let alt_port = config::parse_alt_port(env::var("WEBTRANSPORT_ALT_PORT").ok().as_deref(), port);
    let alt_server = match alt_port.map(|p| (p, Endpoint::server(make_server_config(p)))) {
        Some((p, Ok(ep))) => { info!("Listening on alternate UDP :{} (WEBTRANSPORT_ALT_PORT)", p); Some(ep) }
        Some((p, Err(e))) => { warn!("Alternate WebTransport port :{} unavailable ({}); main port only", p, e); None }
        None => None,
    };
    let alt_port = if alt_server.is_some() { alt_port } else { None };

    // ── 4b. Netprobe (server-assisted network diagnosis, src/netdiag.rs) ──────
    // Arm commands over NATS, optional UDP diagnostic port(s) from
    // NETPROBE_UDP_PORTS (off when unset), reports back to identity-node.
    netdiag::start(
        nats_client.clone(),
        node_id.clone(),
        env::var("PUBLIC_URL").unwrap_or_else(|_| format!("https://localhost:{}", port)),
    ).await;

    // ── 5. Heartbeat publisher ────────────────────────────────────────────────
    // Also serves as the Phase A capacity heartbeat consumed by identity-node's
    // discovery.ts to populate media_nodes — payload must be rebuilt every tick
    // (not built once like the old single-URL-only version) since the capacity
    // counts are live.
    if let Some(nats_clone) = nats_client.clone() {
        let public_url = env::var("PUBLIC_URL")
            .unwrap_or_else(|_| format!("https://localhost:{}", port));
        let rooms_clone = rooms.clone();
        let identity = heartbeat::NodeIdentity { public_url, node_id: node_id.clone(), region: region.clone(), alt_port };
        let subject = nats::heartbeat_subject(&node_id);
        let heartbeat_interval = cfg.heartbeat_interval;
        let drains_hb = drains.clone();
        let video_hb = video_sessions.clone();
        info!("Heartbeat: publishing to '{}' every {:?}", subject, heartbeat_interval);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(heartbeat_interval);
            // Delay (not the default Burst) so a stalled tick just pushes the next
            // one back instead of firing a catch-up burst of near-back-to-back
            // ticks -- keeps the elapsed-time measurement sane (never near-0).
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            // Persistent across ticks: sysinfo needs a prior reading to compute a CPU
            // delta, so global_cpu_usage() is only meaningful from the second tick
            // onward (first tick reports 0, which is fine for a 5s-cadence gauge).
            let mut sys = System::new_all();
            // This is a relay, not a compute node — network throughput saturates
            // long before CPU/mem do, so it's the primary capacity signal despite
            // being the last one added. Host-level NIC counters (not per-connection
            // instrumentation) are enough since this box only carries relay + minor
            // control traffic.
            let mut networks = sysinfo::Networks::new_with_refreshed_list();
            // Real elapsed time between samples, not the nominal 5s interval -- if a
            // tick is ever late (lock contention, a slow syscall, runtime busy), the
            // accumulated byte delta actually covers more than 5s and dividing by a
            // fixed 5.0 would report an inflated, traffic-uncorrelated Mbps spike.
            let mut last_sample = Instant::now();
            loop {
                interval.tick().await;
                let elapsed_secs = last_sample.elapsed().as_secs_f64();
                last_sample = Instant::now();

                // Sum live capacity across all rooms. Nesting the per-room
                // video_sharers read-lock inside the rooms read-lock mirrors the
                // existing pattern used elsewhere (e.g. handle_video_publish's
                // overlay task) — no new lock-ordering risk.
                // Orgs with a drain in progress (usually none) — the room walk
                // below also notes which of them still have voice members here.
                let draining_orgs = drains_hb.orgs();
                let mut draining_orgs_with_voice: HashSet<String> = HashSet::new();
                let (voice_sessions, video_viewers, video_sharers) = {
                    let rooms_guard = rooms_clone.read().await;
                    let mut voice = 0usize;
                    let mut viewers = 0usize;
                    let mut sharers = 0usize;
                    for room in rooms_guard.values() {
                        voice   += room.members.len();
                        viewers += room.video_viewer_count.load(Ordering::Relaxed) as usize;
                        sharers += room.video_sharers.read().await.len();
                        if !draining_orgs.is_empty() {
                            for org in room.member_orgs.values() {
                                if draining_orgs.contains(org) { draining_orgs_with_voice.insert(org.clone()); }
                            }
                        }
                    }
                    (voice, viewers, sharers)
                };
                let draining = !draining_orgs.is_empty() && drains_hb.evaluate(Instant::now(), |org| {
                    draining_orgs_with_voice.contains(org) || video_hb.count_org(org) > 0
                });

                sys.refresh_cpu_usage();
                sys.refresh_memory();
                let cpu_pct = sys.global_cpu_usage();
                let mem_pct = if sys.total_memory() > 0 {
                    (sys.used_memory() as f64 / sys.total_memory() as f64 * 100.0) as f32
                } else {
                    0.0
                };

                // remove_not_listed_interfaces=true so an interface that disappears
                // (unlikely on a cloud droplet, but cheap to handle) doesn't linger
                // with stale counters. Loopback is excluded — it's not egress/ingress
                // capacity and would dilute the signal we actually care about.
                networks.refresh(true);
                let (rx_bytes, tx_bytes) = networks
                    .list()
                    .iter()
                    .filter(|(name, _)| {
                        let n = name.to_lowercase();
                        !n.contains("loopback") && n != "lo" && !n.starts_with("lo:")
                    })
                    .fold((0u64, 0u64), |(rx, tx), (_, data)| {
                        (rx + data.received(), tx + data.transmitted())
                    });
                // Bytes since last refresh -> Mbps, using the real measured gap
                // (elapsed_secs) rather than assuming the nominal 5s interval held.
                let net_rx_mbps = (rx_bytes as f64 * 8.0) / elapsed_secs / 1_000_000.0;
                let net_tx_mbps = (tx_bytes as f64 * 8.0) / elapsed_secs / 1_000_000.0;

                let payload = heartbeat::heartbeat_payload(&identity, &heartbeat::Capacity {
                    voice_sessions, video_viewers, video_sharers,
                    cpu_pct: cpu_pct as f64, mem_pct: mem_pct as f64, net_rx_mbps, net_tx_mbps,
                    draining,
                });
                if let Err(e) = nats_clone.publish(
                    subject.clone(), bytes::Bytes::from(payload),
                ).await {
                    error!("Heartbeat publish failed: {}", e);
                }
            }
        });
    }

    // ── 6a. Accept on the alternate port (same handler as section 6) ─────────
    if let Some(alt) = alt_server {
        let (sessions, move_senders, rooms) = (sessions.clone(), move_senders.clone(), rooms.clone());
        let (nats_alt, tree_alt, node_alt) = (nats_client.clone(), channel_tree.clone(), node_ctx.clone());
        tokio::spawn(async move {
            loop {
                let incoming_session = alt.accept().await;
                let (sessions, move_senders, rooms) = (sessions.clone(), move_senders.clone(), rooms.clone());
                let (nats_s, tree_s, node_s) = (nats_alt.clone(), tree_alt.clone(), node_alt.clone());
                tokio::spawn(async move {
                    handle_connection(incoming_session, sessions, rooms, move_senders, nats_s, tree_s, node_s).await;
                });
            }
        });
    }

    // ── 6. Accept connections ─────────────────────────────────────────────────
    loop {
        let incoming_session = server.accept().await;
        let node_ctx         = node_ctx.clone();
        let sessions         = sessions.clone();
        let move_senders     = move_senders.clone();
        let rooms            = rooms.clone();
        let nats_for_session = nats_client.clone();
        let tree_for_session = channel_tree.clone();

        tokio::spawn(async move {
            handle_connection(
                incoming_session, sessions, rooms,
                move_senders, nats_for_session, tree_for_session,
                node_ctx,
            ).await;
        });
    }
}

// ── NATS command handler ───────────────────────────────────────────────────────
async fn handle_nats_commands(
    nats: async_nats::Client,
    sessions: SessionRegistry,
    rooms: RoomRegistry,
    move_senders: MoveRegistry,
    channel_tree: ChannelTreeRegistry,
    video_sessions: VideoRegistry,
    drains: Arc<drain::DrainTracker>,
) {
    let subject = crate::nats::CMD_SUBSCRIPTION;
    let mut subscriber = match nats.subscribe(subject).await {
        Ok(s)  => s,
        Err(e) => { error!("Failed to subscribe to NATS commands: {}", e); return; }
    };

    // Also subscribe to event tree updates
    let event_subject = crate::nats::EVENT_TREE_SUBSCRIPTION;
    let mut event_subscriber = match nats.subscribe(event_subject).await {
        Ok(s)  => s,
        Err(e) => { error!("Failed to subscribe to event tree updates: {}", e); return; }
    };

    info!("Listening for NATS commands on '{}' and event trees on '{}'", subject, event_subject);

    loop {
        tokio::select! {
            Some(msg) = subscriber.next() => {
                let Some(cmd) = crate::nats::parse_command(msg.subject.as_str()) else {
                    debug!("Ignoring malformed NATS command subject: {}", msg.subject);
                    continue;
                };

                match cmd {
            Command::Kick { user_id: target } => {
                info!("KICK command for {}", target);
                let prefix = format!("{}:", target);
                let registry = sessions.read().await;
                let mut kicked = 0usize;
                for (key, tx) in registry.iter() {
                    if key.starts_with(&prefix) {
                        if tx.send(()).is_ok() { kicked += 1; }
                    }
                }
                if kicked > 0 {
                    info!("Kill signal sent to {} session(s) for {}", kicked, target);
                } else {
                    warn!("User {} not found for KICK", target);
                }
            }
            Command::DrainOrg { org_id: target_org } => {
                // Force-closes every session belonging to one org, without touching
                // other orgs sharing this node — used during a node migration so
                // draining is scoped to the org being moved, not the whole node
                // (a whole-node drain causes a synchronized mass-disconnect across
                // every unrelated org that happens to be hosted here). This bus is
                // unauthenticated unless NATS credentials are configured (see note
                // above on "kick") — drain_org can silently empty an entire org's
                // channels, so it inherits that exposure and then some.
                //
                // Voice sessions get the kill signal; video (share publish and
                // subscribe) sessions are closed directly, so a sharer and its
                // viewers also reconnect to the org's new node instead of staying
                // here until their voice session happens to end.
                info!("DRAIN_ORG command for org {}", target_org);
                drains.begin(target_org);
                let sessions_snapshot = sessions.read().await;
                let mut drained = 0usize;
                {
                    let rooms_lock = rooms.read().await;
                    for (channel_id, state) in rooms_lock.iter() {
                        for (uid, org) in state.member_orgs.iter() {
                            if org == target_org {
                                let key = format!("{}:{}", uid, channel_id);
                                if let Some(tx) = sessions_snapshot.get(&key) {
                                    if tx.send(()).is_ok() { drained += 1; }
                                }
                            }
                        }
                    }
                }
                drop(sessions_snapshot);
                let video_closed = video_sessions.close_org(target_org);
                info!("Drained {} voice session(s) and {} video session(s) for org {}", drained, video_closed, target_org);
            }
            Command::Mute { user_id: target } => {
                info!("MUTE command for {}", target);
                let mut rooms_lock = rooms.write().await;
                for state in rooms_lock.values_mut() {
                    if state.members.contains(target) {
                        state.user_gains.insert(target.to_string(), 0.0);
                        break;
                    }
                }
            }
            Command::Unmute { user_id: target } => {
                info!("UNMUTE command for {}", target);
                let mut rooms_lock = rooms.write().await;
                for state in rooms_lock.values_mut() {
                    if state.members.contains(target) {
                        state.user_gains.insert(target.to_string(), 1.0);
                        break;
                    }
                }
            }
            Command::Move { user_id: target, channel_id: new_channel } => {
                info!("MOVE command for {} → {}", target, new_channel);
                let prefix = format!("{}:", target);
                let move_reg = move_senders.read().await;
                let mut moved = 0usize;
                for (key, move_tx) in move_reg.iter() {
                    if key.starts_with(&prefix) {
                        if move_tx.send(new_channel.to_string()).await.is_ok() { moved += 1; }
                    }
                }
                if moved == 0 {
                    warn!("User {} not found for MOVE", target);
                }
            }
            Command::Unhandled { verb: other } => {
                debug!("Unhandled NATS command verb: {}", other);
            }
                }
            }

            Some(ev_msg) = event_subscriber.next() => {
                apply_channel_tree_payload(&channel_tree, &ev_msg.payload).await;
            }
        }
    }
}

/// Apply a `{ type: "event_tree", channels: [...] }`-shaped payload into the
/// channel tree registry. Shared by the live `specter.event.tree.>`
/// subscription above and the startup backfill request in `main()` below, so
/// a relay that restarts mid-event reconstructs the same state it would have
/// received via live publishes instead of starting (and silently staying)
/// empty for any channel not re-published since.
async fn apply_channel_tree_payload(channel_tree: &ChannelTreeRegistry, payload: &[u8]) {
    let Ok(payload_str) = std::str::from_utf8(payload) else { return };
    let Ok(data) = serde_json::from_str::<serde_json::Value>(payload_str) else { return };
    if data.get("type").and_then(|t| t.as_str()) != Some("event_tree") { return; }
    let Some(channels) = data.get("channels").and_then(|c| c.as_array()) else { return };

    let mut tree = channel_tree.write().await;
    for ch in channels {
        let id = ch.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
        if id.is_empty() { continue; }
        let parent_id = ch.get("parent_id").and_then(|v| v.as_str()).map(|s| s.to_string());
        let tier = ch.get("tier").and_then(|v| v.as_u64()).unwrap_or(0) as u8;
        let leader_user_id = ch.get("leader_user_id").and_then(|v| v.as_str()).map(|s| s.to_string());
        tree.insert(id.clone(), ChannelTreeNode { parent_id, tier, leader_user_id });
        info!("Event tree: channel {} tier {} registered", id, tier);
    }
}

// ── Per-connection handler ─────────────────────────────────────────────────────
async fn handle_connection(
    incoming_session: wtransport::endpoint::IncomingSession,
    sessions: SessionRegistry,
    rooms: RoomRegistry,
    move_senders: MoveRegistry,
    nats: Option<async_nats::Client>,
    channel_tree: ChannelTreeRegistry,
    node: Arc<NodeContext>,
) {
    let request = match incoming_session.await {
        Ok(req) => req,
        Err(e)  => { error!("Handshake failed: {}", e); return; }
    };

    let path = request.path().to_string();
    // Netprobe: never a real session. Reaching here proves the client's QUIC +
    // HTTP/3 handshake got through; record it for its probe and refuse.
    if netdiag::is_probe_path(&path) {
        netdiag::note_webtransport_probe(&path, request.remote_address());
        request.not_found().await;
        return;
    }
    if path.starts_with("/specter/video") {
        handle_video_connection(request, rooms, nats, node).await;
    } else {
        handle_voice_connection(request, sessions, rooms, move_senders, nats, channel_tree, node).await;
    }
}

async fn handle_voice_connection(
    request: wtransport::endpoint::SessionRequest,
    sessions: SessionRegistry,
    rooms: RoomRegistry,
    move_senders: MoveRegistry,
    nats: Option<async_nats::Client>,
    channel_tree: ChannelTreeRegistry,
    node: Arc<NodeContext>,
) {
    let path    = request.path().to_string();
    let headers = request.headers();
    info!("Incoming connection for path: {}", path);

    // ── 1. Extract token + channel_id ────────────────────────────────────────
    let (token_str, channel_id) = if let Some(h) = headers.get("authorization") {
        (h.strip_prefix("Bearer ").unwrap_or(h).trim().to_string(), String::new())
    } else {
        let mut token   = String::new();
        let mut chan_id = String::new();
        if let Some(pos) = path.find('?') {
            for pair in path[pos + 1..].split('&') {
                let mut kv = pair.splitn(2, '=');
                match (kv.next(), kv.next()) {
                    (Some("token"),      Some(v)) => token   = v.to_string(),
                    (Some("channel_id"), Some(v)) => chan_id = v.to_string(),
                    _ => {}
                }
            }
        }
        (token, chan_id)
    };

    if token_str.is_empty() {
        warn!("Connection rejected: missing token");
        return;
    }

    // ── 2. Validate the media ticket (ES256, or legacy HS256) ─────────────────
    let claims: Claims = match node.verifier.verify(&token_str) {
        Ok(c)  => c,
        Err(ticket::TicketError::Expired) => { warn!("Connection rejected: expired JWT"); return; }
        Err(e) => { warn!("Invalid JWT: {}", e); return; }
    };

    let get_str = |k: &str| -> String {
        claims.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string()
    };
    let purpose = get_str("purpose");
    let user_id = { let s = get_str("sub"); if s.is_empty() { get_str("user_id") } else { s } };
    let org_id  = get_str("org_id");
    let role    = get_str("role");
    let callsign = { let s = get_str("callsign"); if s.is_empty() { user_id.clone() } else { s } };

    if user_id.is_empty() || org_id.is_empty() {
        warn!("Connection rejected: missing sub or org_id");
        return;
    }
    if channel_id.is_empty() {
        warn!("Connection rejected: missing channel_id");
        return;
    }
    if purpose != "media_voice" {
        warn!("Connection rejected: invalid media ticket purpose '{}'", purpose);
        return;
    }

    // Enforce channel binding to prevent cross-channel token replay.
    let token_channel_id = get_str("channel_id");
    if token_channel_id != channel_id {
        warn!(
            "Connection rejected: token channel_id ({}) does not match requested channel_id ({})",
            token_channel_id, channel_id
        );
        return;
    }

    // Priority tiers 1/2 trigger ducking; keep legacy Commander fallback.
    let claimed_level = claims.get("priority_level").and_then(|v| v.as_i64()).unwrap_or(5);
    let legacy_commander = role == "Commander"
        && claims.get("is_priority_channel").and_then(|v| v.as_bool()).unwrap_or(false);
    let is_priority = claimed_level <= 2 || legacy_commander;
    let priority_tier: u8 = if legacy_commander && claimed_level > 2 { 1 } else { claimed_level.clamp(1, 2) as u8 };
    // E2EV: end-to-end encrypted relay voice is the only voice mode (2.0.0+).
    // A voice join must present a ticket that identity-node minted AFTER its
    // client-version gate: voice_relay == true AND a signed client_version at
    // or above MIN_RELAY_CLIENT_VERSION. Tickets from a pre-gate identity-node
    // (voice_relay false/absent, no client_version) and anything a pre-2.0.0
    // client could obtain are refused here, so no room can ever be created in
    // (or joined in) mixed mode — the client-declared version itself is not
    // trusted, only the claim identity-node signed after checking it.
    let voice_relay = claims.get("voice_relay").and_then(|v| v.as_bool()).unwrap_or(false);
    let listen_only = ticket_listen_only(&claims);
    let ticket_client_version = get_str("client_version");
    if !voice_relay {
        warn!("Connection rejected: non-relay (mixed) voice ticket for user={} channel={} — voice is end-to-end only", user_id, channel_id);
        return;
    }
    if !client_version_ok(&ticket_client_version) {
        warn!(
            "Connection rejected: ticket client_version '{}' below minimum '{}' (user={}, channel={})",
            ticket_client_version, min_relay_client_version(), user_id, channel_id
        );
        return;
    }
    info!("JWT OK — user={}, org={}, channel={}, priority={}, voice_relay={}, client={}", user_id, org_id, channel_id, is_priority, voice_relay, ticket_client_version);

    // ── Billing counters ──────────────────────────────────────────────────────
    let session_start     = Instant::now();
    let bytes_out_counter = Arc::new(AtomicU64::new(0));

    if let Some(ref n) = nats {
        let p = crate::nats::to_payload(&crate::nats::SessionStart {
            org_id: &org_id, user_id: &user_id, channel_id: &channel_id, node_id: &node.node_id,
        });
        let _ = n.publish(crate::nats::SESSION_START_SUBJECT, p).await;
    }

    // ── 3. Accept session ─────────────────────────────────────────────────────
    let session = match request.accept().await {
        Ok(s)  => { info!("Session established for {}", user_id); s }
        Err(e) => { error!("Session accept failed: {}", e); return; }
    };

    // ── 4. Kill + Move channels ───────────────────────────────────────────────
    let (kill_tx, kill_rx) = broadcast::channel::<()>(1);
    let (move_tx, move_rx) = mpsc::channel::<String>(4);

    // Key by user_id:channel_id so the same user can hold simultaneous sessions
    // on different channels (e.g. passive liaison monitoring) without self-kicking.
    let session_key = format!("{}:{}", user_id, channel_id);

    // Kept so cleanup can tell "replaced by a newer session for this key"
    // (the registry now holds someone else's sender) from an admin
    // kick/drain_org (the registry still holds ours).
    let my_kill_tx = kill_tx.clone();
    {
        let mut reg = sessions.write().await;
        if let Some(old_tx) = reg.insert(session_key.clone(), kill_tx) {
            warn!("Booting duplicate session for {}", user_id);
            let _ = old_tx.send(());
        }
    }
    { move_senders.write().await.insert(session_key.clone(), move_tx); }

    // ── 5. Join / create room ─────────────────────────────────────────────────
    // Pre-create channels in case this is a brand-new room; the closures below
    // consume them only if `or_insert_with` fires (i.e., room didn't exist).
    // Keep the PCM ingress queue shallow so the mixer always works on recent audio.
    // At 20 ms/frame, 5 slots = 100 ms.  Frames that arrive while the mixer holds the
    // room lock are dropped via try_send rather than queued for seconds.
    let (new_pcm_tx, new_pcm_rx) = mpsc::channel::<(String, Vec<i16>)>(5);
    let new_uos: Arc<RwLock<HashMap<String, mpsc::Sender<Box<[u8]>>>>> =
        Arc::new(RwLock::new(HashMap::new()));
    let new_uos_clone    = new_uos.clone();
    let (new_roster_tx, _) = broadcast::channel::<String>(100);
    // Small — control messages only (join/leave announces, viewer-count updates).
    let (new_video_ctrl_tx, _) = broadcast::channel::<bytes::Bytes>(100);

    // Holds (pcm_rx, uos) only when a new room was created during this call.
    let mut spawn_mixer: Option<(
        mpsc::Receiver<(String, Vec<i16>)>,
        Arc<RwLock<HashMap<String, mpsc::Sender<Box<[u8]>>>>>,
    )> = None;
    // Set when a brand-new relay-mode room was created this call — see
    // duck_release_sweeper.
    let mut spawn_duck_sweeper = false;

    // Nonce assigned inside the rooms write-lock below; used later in cleanup.
    let mut join_nonce: usize = 0;
    // Captured outside the block below (which drops `is_new` at its closing
    // brace) so the retroactive leader dual-subscribe check after it can tell
    // whether this connection just created a brand-new room.
    let mut is_new_room = false;

    let (pcm_tx, uos_arc, _roster_tx_clone, roster_rx, video_ctrl_tx, video_ctrl_rx, _video_vc, video_sharers_arc, _video_headers_arc, _video_keyframes_arc, snapshot, ssrc_map) = {
        let mut room_registry = rooms.write().await;
        let is_new = !room_registry.contains_key(&channel_id);
        is_new_room = is_new;

        if is_new {
            info!("Creating new room: {}", channel_id);
            room_registry.insert(channel_id.clone(), RoomState {
                roster_tx:           new_roster_tx,
                members:             HashSet::new(),
                callsigns:           HashMap::new(),
                user_gains:          HashMap::new(),
                user_audio_thresholds: HashMap::new(),
                local_mutes:         HashMap::new(),
                priority_levels:     HashMap::new(),
                priority_speaker:    None,
                priority_release_at: None,
                last_priority_packet_at: HashMap::new(),
                pcm_tx:              new_pcm_tx,
                user_output_senders: new_uos_clone,
                video_ctrl_tx:          new_video_ctrl_tx,
                video_streams:          Arc::new(RwLock::new(HashMap::new())),
                video_viewer_count:     Arc::new(AtomicU32::new(0)),
                video_sharers:          Arc::new(RwLock::new(HashMap::new())),
                video_headers:          Arc::new(RwLock::new(HashMap::new())),
                video_keyframes:        Arc::new(RwLock::new(HashMap::new())),
                video_keyframe_requests: Arc::new(RwLock::new(HashMap::new())),
                video_activation_senders:    Arc::new(RwLock::new(HashMap::new())),
                session_nonces:              HashMap::new(),
                video_publish_nonces:        Arc::new(RwLock::new(HashMap::new())),
                member_orgs:                 HashMap::new(),
                voice_relay_mode:            voice_relay,
            });
            // A brand-new E2eRelay room has nothing for mixer_task to do — it
            // never decodes audio, so there's no PCM to mix. It needs the
            // release sweeper instead (see duck_release_sweeper), since it has
            // no per-tick mixer loop to check priority_release_at from.
            // E2EV: voice_relay is always true here (non-relay tickets are
            // rejected above), so the mixed branch below — mixer_task and the
            // decode path in run_session_loop — is unreachable. It is kept
            // only to keep this release's diff small; follow-up: delete
            // mixer_task, the PCM ingress and the per-session Opus decoder.
            if !voice_relay {
                spawn_mixer = Some((new_pcm_rx, new_uos));
            } else {
                spawn_duck_sweeper = true;
            }
        }

        let state = room_registry.get_mut(&channel_id).unwrap();

        // A room's wire semantics (server-mixed vs. per-sender relay) are fixed
        // at creation and can't be mixed within one room — reject a joiner whose
        // own token disagrees with whatever this room already established,
        // mirroring the token_channel_id check above. This can only happen for
        // an *existing* room (a brand-new one always matches its own creator's
        // claim), so voice_relay_mode was just set from `voice_relay` a few
        // lines up in that case and this comparison is trivially true there.
        if state.voice_relay_mode != voice_relay {
            warn!(
                "Connection rejected: voice_relay ({}) does not match room {}'s established mode ({})",
                voice_relay, channel_id, state.voice_relay_mode
            );
            sessions.write().await.remove(&session_key);
            move_senders.write().await.remove(&session_key);
            return;
        }

        state.members.insert(user_id.clone());
        state.callsigns.insert(user_id.clone(), callsign.clone());
        state.user_gains.insert(user_id.clone(), 1.0);
        state.user_audio_thresholds.insert(user_id.clone(), 150.0);
        state.member_orgs.insert(user_id.clone(), org_id.clone());
        if is_priority { state.priority_levels.insert(user_id.clone(), priority_tier); }

        // Record a unique nonce for this join so that cleanup can detect
        // whether a newer session has already re-claimed this user's slot.
        join_nonce = SESSION_NONCE.fetch_add(1, Ordering::Relaxed);
        state.session_nonces.insert(user_id.clone(), join_nonce);

        let snap: Vec<String> = state.members.iter()
            .map(|uid| state.callsigns.get(uid).cloned().unwrap_or_else(|| uid.clone()))
            .collect();
        let ssrc_map: HashMap<u32, String> = state.members.iter()
            .map(|uid| (canonical_ssrc(uid), uid.clone()))
            .collect();
        let join = serde_json::to_string(&RosterMessage::Join(callsign.clone())).unwrap();
        let _ = state.roster_tx.send(join);
        // Re-broadcast the updated map so already-connected members learn this
        // joiner's ssrc too — the initial snapshot below only reaches the joiner.
        let ssrc_map_msg = serde_json::to_string(&RosterMessage::SsrcMap(ssrc_map.clone())).unwrap();
        let _ = state.roster_tx.send(ssrc_map_msg);

        (
            state.pcm_tx.clone(),
            state.user_output_senders.clone(),
            state.roster_tx.clone(),
            state.roster_tx.subscribe(),
            state.video_ctrl_tx.clone(),
            state.video_ctrl_tx.subscribe(),
            state.video_viewer_count.clone(),
            state.video_sharers.clone(),
            state.video_headers.clone(),
            state.video_keyframes.clone(),
            snap,
            ssrc_map,
        )
    };

    // Spawn mixer after lock release to avoid deadlocks.
    if let Some((pcm_rx, uos)) = spawn_mixer {
        tokio::spawn(mixer_task(channel_id.clone(), rooms.clone(), pcm_rx, uos, nats.clone(), channel_tree.clone()));
    }
    if spawn_duck_sweeper {
        tokio::spawn(duck_release_sweeper(channel_id.clone(), rooms.clone()));
    }

    // ── Retroactive leader dual-subscribe for a newly-created parent room ──────
    // The forward-direction check further below runs when a LEADER connects,
    // and only registers them into their parent room if that room already
    // exists (has at least one member) at that exact moment — if it doesn't,
    // the registration is silently skipped and never retried. So: a leader
    // connects to their child channel while the parent room is still empty →
    // skipped. Later, someone else joins the parent, creating it for the
    // first time — this is that moment. Catch up here: find any child of this
    // brand-new room whose tree-designated leader is already connected there,
    // and register that leader's existing output sender into this room too.
    // E2EV: skipped for relay rooms (= every room now). A parent room's relay
    // frames are sealed with the PARENT channel's MLS key, which the leader's
    // child-channel session doesn't hold, so forwarding them only produced
    // undecryptable traffic (dropped client-side). Leaders still hear their
    // commander via the event-key priority cascade; hearing the whole parent
    // channel needs a client-side monitor of it (follow-up, see plan).
    if is_new_room && !voice_relay {
        let child_leaders: Vec<(String, String)> = {
            let tree = channel_tree.read().await;
            tree.iter()
                .filter(|(_, node)| node.parent_id.as_deref() == Some(channel_id.as_str()))
                .filter_map(|(id, node)| node.leader_user_id.clone().map(|lid| (id.clone(), lid)))
                .collect()
        };

        if !child_leaders.is_empty() {
            let rooms_lock = rooms.read().await;
            for (child_id, leader_id) in &child_leaders {
                if let Some(child_room) = rooms_lock.get(child_id) {
                    let leader_tx = child_room.user_output_senders.read().await.get(leader_id).cloned();
                    if let Some(leader_tx) = leader_tx {
                        uos_arc.write().await.insert(leader_id.clone(), leader_tx);
                        info!("Retroactively dual-subscribed leader {} (child {}) into newly-created parent room {}", leader_id, child_id, channel_id);
                    }
                }
            }
        }
    }

    // Create per-user output channel and register it.
    // Output queue: 5 frames = 100 ms.  send_datagram is non-blocking so this drains
    // instantly; the cap just prevents 1-second audio build-up when the select! loop
    // is briefly starved by roster or video arms.
    let (out_tx, out_rx) = mpsc::channel::<Box<[u8]>>(5);
    { uos_arc.write().await.insert(user_id.clone(), out_tx.clone()); }

    // ── Leader dual-subscribe: register output sender in parent channel room ──
    let mut leader_parent_channel: Option<String> = None;
    if !voice_relay { // E2EV: see the retroactive dual-subscribe note above.
        let tree = channel_tree.read().await;
        if let Some(node) = tree.get(&channel_id) {
            if node.leader_user_id.as_deref() == Some(user_id.as_str()) {
                if let Some(ref parent_id) = node.parent_id {
                    let rooms_lock = rooms.read().await;
                    if let Some(parent_room) = rooms_lock.get(parent_id) {
                        parent_room.user_output_senders.write().await
                            .insert(user_id.clone(), out_tx.clone());
                        leader_parent_channel = Some(parent_id.clone());
                        info!("Leader {} dual-subscribed to parent channel {}", callsign, parent_id);
                    }
                }
            }
        }
    }

    // ── 6. Roster snapshot stream ─────────────────────────────────────────────
    info!("Opening roster stream for {}", user_id);
    let mut roster_stream = match session.open_uni().await {
        Ok(opening) => match opening.await {
            Ok(s)  => s,
            Err(e) => { error!("Uni stream open failed: {}", e); return; }
        },
        Err(e) => { error!("Uni stream request failed: {}", e); return; }
    };

    let snap_json = serde_json::to_string(&RosterMessage::Snapshot(snapshot)).unwrap();
    // Write type prefix 0x01 (roster) then snapshot. A failure here means the
    // client will never learn who else is in the room — not worth holding the
    // session slot open for run_session_loop to eventually notice on its own;
    // skip straight to cleanup below instead.
    let mut roster_write_ok = true;
    if let Err(e) = roster_stream.write_all(&[0x01]).await {
        error!("Failed to write roster prefix to {}: {}", user_id, e);
        roster_write_ok = false;
    }
    if roster_write_ok {
        if let Err(e) = roster_stream.write_all(format!("{}\n", snap_json).as_bytes()).await {
            error!("Failed to send roster snapshot to {}: {}", user_id, e);
            roster_write_ok = false;
        }
    }

    // ssrc -> user_id for every current member — see RosterMessage::SsrcMap's
    // doc comment. Sent unconditionally (cheap, small); only relay-mode clients
    // act on it.
    if roster_write_ok {
        let ssrc_map_json = serde_json::to_string(&RosterMessage::SsrcMap(ssrc_map)).unwrap();
        if let Err(e) = roster_stream.write_all(format!("{}\n", ssrc_map_json).as_bytes()).await {
            error!("Failed to send ssrc map to {}: {}", user_id, e);
            roster_write_ok = false;
        }
    }

    // Send current share state to new joiner on the reliable uni stream (not datagrams)
    if roster_write_ok {
        let sharers = video_sharers_arc.read().await;
        if !sharers.is_empty() {
            let sharer_callsigns: Vec<String> = sharers.values().cloned().collect();
            let sharers_json = serde_json::to_string(&RosterMessage::Sharers(sharer_callsigns)).unwrap();
            if let Err(e) = roster_stream.write_all(format!("{}\n", sharers_json).as_bytes()).await {
                error!("Failed to send sharer list to {}: {}", user_id, e);
            }
        }
    }

    // ── 7. Run session loop ───────────────────────────────────────────────────
    let _was_killed = if roster_write_ok {
        run_session_loop(
            session, kill_rx, move_rx, user_id.clone(), callsign.clone(),
            pcm_tx, out_rx, roster_stream, roster_rx,
            bytes_out_counter.clone(),
            video_ctrl_rx, video_ctrl_tx,
            rooms.clone(), channel_id.clone(),
            voice_relay, channel_tree.clone(), nats.clone(),
            listen_only,
        ).await
    } else {
        warn!("Session {} aborting before entering session loop — initial roster snapshot failed to send", user_id);
        false
    };

    // ── 8. Cleanup ────────────────────────────────────────────────────────────
    // When replaced by a duplicate session, the NEW session has already registered
    // its own entries in sessions/move_senders/room state. Removing here would
    // orphan the new session (mixer can't send audio, roster shows Leave, etc.).
    //
    // "Replaced" is decided by whether the registry still holds THIS session's
    // kill sender (checked and removed under one lock), not by whether the
    // kill signal fired: an admin kick or drain_org fires the same signal,
    // and treating those as "replaced" used to skip cleanup entirely — the
    // user stayed in the room as a ghost member (inflating the heartbeat's
    // voice_sessions and keeping a drained org on this node) after their
    // client had already reconnected elsewhere.
    let superseded = {
        let mut reg = sessions.write().await;
        match reg.get(&session_key) {
            Some(tx) if tx.same_channel(&my_kill_tx) => { reg.remove(&session_key); false }
            Some(_) => true,
            None => false,
        }
    };
    drop(my_kill_tx);
    if !superseded {
        { move_senders.write().await.remove(&session_key); }

        // Remove from per-user output senders (take Arc outside rooms lock to avoid deadlock).
        if let Some(uos) = {
            let rr = rooms.read().await;
            rr.get(&channel_id).map(|s| s.user_output_senders.clone())
        } {
            uos.write().await.remove(&user_id);
        }

        // Remove leader dual-subscribe from parent channel if applicable
        if let Some(ref parent_id) = leader_parent_channel {
            if let Some(parent_uos) = {
                let rr = rooms.read().await;
                rr.get(parent_id).map(|s| s.user_output_senders.clone())
            } {
                parent_uos.write().await.remove(&user_id);
                info!("Leader {} removed from parent channel {}", user_id, parent_id);
            }
        }

        {
            let mut room_registry = rooms.write().await;
            if let Some(state) = room_registry.get_mut(&channel_id) {
                // Only remove the user if our nonce still matches.  A mismatch means
                // a new session already re-joined and reclaimed the room slot, so
                // removing here would incorrectly evict the live session.
                let current_nonce = state.session_nonces.get(&user_id).copied();
                if current_nonce != Some(join_nonce) {
                    info!(
                        "Session {} cleanup skipped — nonce mismatch (new session already joined).",
                        user_id
                    );
                } else {
                    state.session_nonces.remove(&user_id);
                    state.members.remove(&user_id);
                    let display_name = state.callsigns.remove(&user_id).unwrap_or_else(|| user_id.clone());
                    state.user_gains.remove(&user_id);
                    state.user_audio_thresholds.remove(&user_id);
                    state.local_mutes.remove(&user_id);
                    state.priority_levels.remove(&user_id);
                    state.last_priority_packet_at.remove(&user_id);
                    state.member_orgs.remove(&user_id);

                    if state.priority_speaker.as_deref() == Some(user_id.as_str()) {
                        state.priority_speaker    = None;
                        state.priority_release_at = None;
                    }

                    let leave = serde_json::to_string(&RosterMessage::Leave { callsign: display_name, user_id: user_id.clone() }).unwrap();
                    let _ = state.roster_tx.send(leave);

                    if state.members.is_empty() {
                        info!("Room {} empty — disposing (mixer exits when pcm_tx drops).", channel_id);
                        room_registry.remove(&channel_id);
                    }
                }
            }
        }
    } else {
        info!("Session {} was replaced by duplicate — skipping shared-state cleanup.", user_id);
    }

    if let Some(ref n) = nats {
        let dur   = session_start.elapsed().as_secs();
        let bytes = bytes_out_counter.load(Ordering::Relaxed);
        // `superseded` tells consumers (billingConsumer's presence eviction) that
        // this session was replaced by a newer one for the same user and should
        // NOT be treated as a real departure — the new session already owns
        // presence for this user. Billing usage is still reported either way.
        let p = crate::nats::to_payload(&crate::nats::SessionEnd {
            org_id: &org_id, user_id: &user_id, channel_id: &channel_id,
            duration_secs: dur, bytes_out: bytes, superseded: Some(superseded),
            node_id: &node.node_id,
        });
        let _ = n.publish(node.session_end_subject.clone(), p).await;
    }

    info!("Session closed for {}", user_id);
}

// ── Per-session I/O loop ───────────────────────────────────────────────────────
async fn run_session_loop(
    session: wtransport::Connection,
    mut kill_rx: broadcast::Receiver<()>,
    mut move_rx: mpsc::Receiver<String>,
    user_id: String,
    callsign: String,
    pcm_tx: mpsc::Sender<(String, Vec<i16>)>,
    mut out_rx: mpsc::Receiver<Box<[u8]>>,
    mut roster_stream: wtransport::SendStream,
    mut roster_rx: broadcast::Receiver<String>,
    bytes_out: Arc<AtomicU64>,
    mut video_ctrl_rx: broadcast::Receiver<bytes::Bytes>,
    video_ctrl_tx: broadcast::Sender<bytes::Bytes>,
    rooms: RoomRegistry,
    channel_id: String,
    voice_relay: bool,
    channel_tree: ChannelTreeRegistry,
    nats: Option<async_nats::Client>,
    listen_only: bool,
) -> bool {
    let mut was_killed = false;
    let mut opus_decoder = match audiopus::coder::Decoder::new(
        audiopus::SampleRate::Hz48000,
        audiopus::Channels::Mono,
    ) {
        Ok(d)  => d,
        Err(e) => { error!("Opus decoder init failed for {}: {:?}", user_id, e); return false; }
    };
    // Maximum Opus frame = 120 ms = 5760 samples @ 48 kHz.
    let mut pcm_buf = vec![0i16; 5760];
    // E2EV: rate limit for relay-mode Speaking roster messages (see below).
    let mut last_speaking_emit: Option<Instant> = None;

    loop {
        tokio::select! {
            // ── Connection dead ────────────────────────────────────────────
            // Fires on a graceful CONNECTION_CLOSE, or once max_idle_timeout
            // elapses with no packets received — the only path that catches a
            // peer that disappeared without closing cleanly.
            _ = session.closed() => {
                info!("Session closed for {} (idle timeout or peer disconnect).", user_id);
                break;
            }

            // ── Admin kill ─────────────────────────────────────────────────
            _ = kill_rx.recv() => {
                warn!("Kill signal for {}. Closing.", user_id);
                session.close(wtransport::VarInt::from_u32(0), b"Admin Kicked");
                was_killed = true;
                break;
            }

            // ── Admin move ─────────────────────────────────────────────────
            new_ch = move_rx.recv() => {
                if let Some(new_channel_id) = new_ch {
                    info!("MOVE signal for {} → {}", user_id, new_channel_id);
                    let move_msg = serde_json::to_string(&RosterMessage::Move(new_channel_id)).unwrap();
                    if let Err(e) = roster_stream.write_all(format!("{}\n", move_msg).as_bytes()).await {
                        debug!("Move message write failed for {}: {}", user_id, e);
                    }
                    session.close(wtransport::VarInt::from_u32(2), b"Admin Move");
                    break;
                }
            }

            // ── Roster broadcast → client ──────────────────────────────────
            msg = roster_rx.recv() => {
                match msg {
                    Ok(json) => {
                        if let Err(e) = roster_stream.write_all(format!("{}\n", json).as_bytes()).await {
                            debug!("Roster write failed for {}: {}", user_id, e);
                            break;
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        warn!("Roster rx lagged {} messages for {} — skipping", n, user_id);
                    }
                }
            }

            // ── Mixed audio from mixer → client datagram ───────────────────
            mixed = out_rx.recv() => {
                match mixed {
                    Some(payload) => {
                        // Billing meters egress — bytes the server actually serves —
                        // not the client's mic upload (see receive_datagram arm below,
                        // which no longer double-counts this).
                        let len = payload.len();
                        if let Err(e) = session.send_datagram(payload) {
                            debug!("Mixed audio send failed for {}: {}", user_id, e);
                            break;
                        }
                        bytes_out.fetch_add(len as u64, Ordering::Relaxed);
                    }
                    None => break, // Mixer channel closed (room empty)
                }
            }

            // ── Video control signals relay ────
            vdata = video_ctrl_rx.recv() => {
                match vdata {
                    Ok(chunk) => {
                        if let Err(e) = session.send_datagram(chunk) {
                            debug!("Control datagram send failed for {}: {}", user_id, e);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        warn!("Video control relay lagged {} messages for {} — subscriber may miss control packet", n, user_id);
                    }
                    Err(_) => {} // Channel closed, continue
                }
            }

            // ── Client datagram → audio or control ─────────────────────────
            datagram = session.receive_datagram() => {
                match datagram {
                    Ok(dgram) => {
                        let payload = dgram.payload();

                        // ── Control datagram (0xFF prefix) ─────────────────
                        if payload.len() >= 2 && payload[0] == 0xFF {
                            // 0x01 = SHARE_ANNOUNCE relay: forward to all other room members.
                            // Rebuild the callsign server-side from this session's authenticated
                            // identity rather than relaying payload[2..] as sent — trusting the
                            // client's bytes let any connected client announce a screen-share
                            // under another user's name.
                            if listen_only && (payload[1] == 0x01 || payload[1] == 0x07) {
                                // Receive-only session: announces nothing.
                            } else if payload[1] == 0x01 && payload.len() >= 4 {
                                let mut sig = vec![0xFF, 0x01, payload[2]];
                                sig.extend_from_slice(callsign.as_bytes());
                                let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));
                            } else if payload[1] == 0x07 && payload.len() >= 3 {
                                // 0x07 = SHARE_AUDIO_STATE: [0xFF, 0x07, on(0/1)] — "my
                                // share carries audio" for the sharer's tile. Relayed
                                // like SHARE_ANNOUNCE, callsign rebuilt from the
                                // session; shipped clients skip unknown 0xFF types.
                                let mut sig = vec![0xFF, 0x07, u8::from(payload[2] != 0)];
                                sig.extend_from_slice(callsign.as_bytes());
                                let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));
                            } else if payload[1] == 0x05 && payload.len() >= 4 {
                                // 0x05 = SET_AUDIO_THRESHOLD: [0xFF, 0x05, hi, lo] (u16 BE raw RMS)
                                let threshold = u16::from_be_bytes([payload[2], payload[3]]) as f32;
                                let mut rooms_lock = rooms.write().await;
                                if let Some(state) = rooms_lock.get_mut(&channel_id) {
                                    state.user_audio_thresholds.insert(user_id.clone(), threshold);
                                    debug!("Audio threshold for {} set to {}", user_id, threshold);
                                }
                            } else if payload[1] == 0x06 && payload.len() >= 4 {
                                // 0x06 = SET_LOCAL_MUTE: [0xFF, 0x06, muted(0/1), target_user_id_utf8...]
                                // Listener-only preference: excludes one speaker from just this
                                // listener's personal mix (see recipient loop in mixer_task).
                                // Has no effect on what anyone else hears.
                                let muted = payload[2] != 0;
                                let target_id = String::from_utf8_lossy(&payload[3..]).to_string();
                                if !target_id.is_empty() {
                                    let mut rooms_lock = rooms.write().await;
                                    if let Some(state) = rooms_lock.get_mut(&channel_id) {
                                        let set = state.local_mutes.entry(user_id.clone()).or_default();
                                        if muted { set.insert(target_id); } else { set.remove(&target_id); }
                                    }
                                }
                            } else {
                                debug!("Unhandled control type 0x{:02x} from {}", payload[1], user_id);
                            }
                            continue;
                        }

                        // ── Audio datagram (proto3 AudioFrame) ─────────────
                        // Mission Wide listener: receive-only, never forwarded.
                        if listen_only {
                            continue;
                        }
                        debug!("{} audio datagram: {} bytes", user_id, payload.len());
                        match proto::specter::v1::AudioFrame::decode(payload.as_ref()) {
                        Ok(frame) if voice_relay && frame.is_global_broadcast => {
                            // Cascade copy: a priority speaker's client sends this SECOND,
                            // separately-encrypted frame (event-scoped cascade key, see
                            // mlsSession.js's ensureEventGroup) alongside their normal
                            // in-channel one whenever they hold a priority role in an event
                            // channel — the server can't re-encrypt the normal frame for
                            // descendant-channel recipients itself (different MLS group), so
                            // it only ever forwards this pre-encrypted copy, and only while
                            // this sender is the room's currently-locked active priority
                            // speaker (see the ducking block below) — otherwise there's no
                            // descendant channel that should be hearing it right now, so it's
                            // simply dropped rather than relayed anywhere.
                            if !frame.encrypted_payload.is_empty() {
                                let is_active_speaker = {
                                    let rooms_lock = rooms.read().await;
                                    rooms_lock.get(&channel_id)
                                        .map(|s| s.priority_speaker.as_deref() == Some(user_id.as_str())
                                            // E2EV: server-muted senders cascade nothing either.
                                            && s.user_gains.get(&user_id).copied() != Some(0.0))
                                        .unwrap_or(false)
                                };
                                if is_active_speaker {
                                    let mut relay_frame = frame;
                                    relay_frame.ssrc = canonical_ssrc(&user_id);
                                    let frame_bytes: Box<[u8]> = relay_frame.encode_to_vec().into_boxed_slice();

                                    let tree = channel_tree.read().await;
                                    let descendants = get_descendants(&tree, &channel_id);
                                    drop(tree);

                                    let rooms_lock = rooms.read().await;
                                    for desc_id in &descendants {
                                        if let Some(desc_room) = rooms_lock.get(desc_id) {
                                            let desc_senders = desc_room.user_output_senders.read().await;
                                            for (_, tx) in desc_senders.iter() {
                                                let _ = tx.try_send(frame_bytes.clone());
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        Ok(frame) if voice_relay => {
                            // Relay mode: never decode. Forward the still-(eventually-)
                            // encrypted payload byte-for-byte to every other room member,
                            // respecting per-listener local_mutes exactly like the mixer's
                            // per-recipient loop does — the only content this server ever
                            // touches is the ssrc field, rewritten from this session's
                            // authenticated identity so a client can't announce its frames
                            // under another user's ssrc (see canonical_ssrc's doc comment).
                            if !frame.encrypted_payload.is_empty() {
                                let mut relay_frame = frame;
                                relay_frame.ssrc = canonical_ssrc(&user_id);
                                let frame_bytes: Box<[u8]> = relay_frame.encode_to_vec().into_boxed_slice();

                                let (senders_arc, local_mutes_snapshot, priority_level, server_muted, roster_tx) = {
                                    let rooms_lock = rooms.read().await;
                                    match rooms_lock.get(&channel_id) {
                                        Some(state) => (
                                            state.user_output_senders.clone(),
                                            state.local_mutes.clone(),
                                            state.priority_levels.get(&user_id).copied(),
                                            // E2EV: admin server-mute (NATS "mute" sets gain 0.0)
                                            // used to be applied by the mixer; in relay mode it
                                            // has to be enforced by not forwarding at all.
                                            state.user_gains.get(&user_id).copied() == Some(0.0),
                                            state.roster_tx.clone(),
                                        ),
                                        None => continue,
                                    }
                                };
                                if server_muted {
                                    continue;
                                }
                                // E2EV: speaking indicator. mixer_task derived
                                // RosterMessage::Speaking from decoded PCM; a relay room
                                // never decodes, so emit it from packet arrival instead
                                // (clients only transmit while their VAD/PTT gate is open,
                                // and the strip treats fresh entries as "speaking"). The
                                // level is a fixed mid value — the server can't measure
                                // loudness of ciphertext, and arrival timing is already
                                // visible to it, so this reveals nothing new.
                                if last_speaking_emit.map(|t| t.elapsed() >= Duration::from_millis(100)).unwrap_or(true) {
                                    last_speaking_emit = Some(Instant::now());
                                    let m = serde_json::to_string(&RosterMessage::Speaking {
                                        callsign: callsign.clone(),
                                        level: RELAY_SPEAKING_LEVEL,
                                    }).unwrap();
                                    let _ = roster_tx.send(m);
                                }
                                let senders = senders_arc.read().await;
                                for (recipient_id, tx) in senders.iter() {
                                    if recipient_id == &user_id { continue; }
                                    if local_mutes_snapshot.get(recipient_id).map(|s| s.contains(&user_id)).unwrap_or(false) {
                                        continue;
                                    }
                                    let _ = tx.try_send(frame_bytes.clone());
                                }
                                drop(senders);

                                // ── Priority ducking: packet arrival replaces mixer_task's
                                // RMS-based is_speaking() check, which needs plaintext PCM the
                                // relay path never has. "First past the post, locked until
                                // release" — a second priority user talking while another is
                                // already the active speaker doesn't preempt them (avoids
                                // flickering between simultaneously-talking priority speakers).
                                if let Some(level) = priority_level {
                                    // Pre-compute descendants before taking the rooms write lock —
                                    // avoids holding channel_tree's lock and rooms' lock at the same
                                    // time (mirrors the discipline in mixer_task's cascade code).
                                    // Descendant channels' listeners are on a different roster
                                    // stream (this room's roster_tx only reaches this room's
                                    // members), so the duck state/signal has to be cascaded to them
                                    // explicitly rather than relying on their own detection — they
                                    // never receive this speaker's audio at all outside the cascade
                                    // AudioFrame path, only the duck/UI effect of it.
                                    let tree = channel_tree.read().await;
                                    let descendants = get_descendants(&tree, &channel_id);
                                    drop(tree);

                                    let mut rooms_lock = rooms.write().await;

                                    // Scoped so `state`'s mutable borrow of rooms_lock ends before
                                    // the descendant loop below needs its own — the borrow checker
                                    // can't tell channel_id and desc_id are different HashMap keys.
                                    let (should_propagate, duck_msg) = {
                                        match rooms_lock.get_mut(&channel_id) {
                                            Some(state) => {
                                                let is_free = state.priority_speaker.is_none();
                                                let is_current_speaker = state.priority_speaker.as_deref() == Some(user_id.as_str());
                                                if is_free || is_current_speaker {
                                                    state.last_priority_packet_at.insert(user_id.clone(), Instant::now());
                                                    state.priority_speaker = Some(user_id.clone());
                                                    state.priority_release_at = Some(Instant::now() + Duration::from_millis(1500));
                                                    let msg = if is_free {
                                                        let m = serde_json::to_string(&RosterMessage::Duck {
                                                            ssrc: canonical_ssrc(&user_id),
                                                            level,
                                                        }).unwrap();
                                                        let _ = state.roster_tx.send(m.clone());
                                                        Some(m)
                                                    } else {
                                                        None
                                                    };
                                                    (true, msg)
                                                } else {
                                                    (false, None)
                                                }
                                            }
                                            None => (false, None),
                                        }
                                    };

                                    if should_propagate {
                                        // Refresh descendants' release timer on every qualifying
                                        // frame (not just at duck-start) — otherwise their ducking
                                        // would flicker released every 1.5s during sustained speech
                                        // while the source room's stays correctly extended. Each
                                        // descendant's own duck_release_sweeper (if it's also
                                        // relay-mode — see the "flip a whole event's channels
                                        // together" rollout note) independently detects and
                                        // announces expiry from this same priority_release_at value,
                                        // so no cross-room release propagation is needed beyond this
                                        // continuous refresh.
                                        for desc_id in &descendants {
                                            if let Some(desc_state) = rooms_lock.get_mut(desc_id) {
                                                desc_state.priority_speaker = Some(user_id.clone());
                                                desc_state.priority_release_at = Some(Instant::now() + Duration::from_millis(1500));
                                                if let Some(ref m) = duck_msg {
                                                    let _ = desc_state.roster_tx.send(m.clone());
                                                }
                                            }
                                        }
                                    }

                                    if duck_msg.is_some() {
                                        if let Some(ref n) = nats {
                                            let duck_payload = format!(
                                                r#"{{"channel_id":"{}","priority_user":"{}","action":"duck"}}"#,
                                                channel_id, user_id
                                            );
                                            let _ = n.publish(
                                                crate::nats::duck_subject(&channel_id),
                                                bytes::Bytes::from(duck_payload),
                                            ).await;
                                        }
                                    }
                                }
                            }
                        }
                        Ok(frame) => {
                            let opus = &frame.encrypted_payload;
                            if !opus.is_empty() {
                                let decode_result = match audiopus::packet::Packet::try_from(opus.as_slice()) {
                                    Ok(packet) => {
                                        let signals = match audiopus::MutSignals::try_from(pcm_buf.as_mut_slice()) {
                                            Ok(s) => s,
                                            Err(e) => { warn!("MutSignals error for {}: {:?}", user_id, e); continue; }
                                        };
                                        opus_decoder.decode(Some(packet), signals, false)
                                    }
                                    Err(e) => { warn!("Invalid Opus packet from {}: {:?}", user_id, e); continue; }
                                };
                                match decode_result {
                                    Ok(n) if n > 0 => {
                                        let _ = pcm_tx.try_send((user_id.clone(), pcm_buf[..n].to_vec()));
                                    }
                                    Ok(_) => {}
                                    Err(e) => warn!("Opus decode error from {}: {:?}", user_id, e),
                                }
                            }
                        }
                        Err(e) => {
                            warn!("AudioFrame proto decode failed from {} ({} bytes): {:?}", user_id, payload.len(), e);
                        }
                        }
                    }
                    Err(e) => {
                        error!("Datagram error ({}): {}", user_id, e);
                        break;
                    }
                }
            }

            // ── Incoming uni streams: route by type prefix ─────────────────
            uni = session.accept_uni() => {
                if let Ok(mut stream) = uni {
                    // Drain unknown streams
                    let mut buf = vec![0u8; 4096];
                    loop {
                        match tokio::io::AsyncReadExt::read(&mut stream, &mut buf).await {
                            Ok(0) | Err(_) => break,
                            Ok(_) => {}
                        }
                    }
                }
            }
        }
    }

    was_killed
}

async fn handle_video_connection(
    request: wtransport::endpoint::SessionRequest,
    rooms: RoomRegistry,
    nats: Option<async_nats::Client>,
    node: Arc<NodeContext>,
) {
    let path = request.path().to_string();
    let mut token = String::new();
    let mut channel_id = String::new();
    let mut role = String::new();
    let mut sharer = String::new();
    // Subscriber capability: this viewer understands share-audio frames (see
    // SHARE_FRAME_FLAG_AUDIO). Absent = a shipped client: audio is withheld.
    let mut wants_share_audio = false;
    // ...and takes it as datagrams on this session (share_audio.rs).
    let mut wants_share_audio_dgram = false;

    if let Some(pos) = path.find('?') {
        for pair in path[pos + 1..].split('&') {
            let mut kv = pair.splitn(2, '=');
            match (kv.next(), kv.next()) {
                (Some("token"), Some(v)) => token = v.to_string(),
                (Some("channel_id"), Some(v)) => channel_id = v.to_string(),
                (Some("role"), Some(v)) => role = v.to_string(),
                (Some("share_audio"), Some(v)) => wants_share_audio = v == "1",
                (Some("share_audio_dgram"), Some(v)) => wants_share_audio_dgram = v == "1",
                (Some("sharer"), Some(v)) => sharer = urlencoding::decode(v).unwrap_or(std::borrow::Cow::Borrowed(v)).to_string(),
                _ => {}
            }
        }
    }

    if token.is_empty() || channel_id.is_empty() || role.is_empty() {
        warn!("Video connection rejected: missing params");
        return;
    }

    let claims: Claims = match node.verifier.verify(&token) {
        Ok(c) => c,
        Err(ticket::TicketError::Expired) => { warn!("Video connection rejected: expired JWT"); return; }
        Err(e) => { warn!("Invalid JWT: {}", e); return; }
    };

    let user_id = claims.get("sub").or_else(|| claims.get("user_id")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let callsign = claims.get("callsign").and_then(|v| v.as_str()).unwrap_or(&user_id).to_string();
    let org_id = claims.get("org_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let purpose = claims.get("purpose").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let media_role = claims.get("media_role").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let token_sharer = claims.get("sharer").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    if user_id.is_empty() {
        warn!("Video connection rejected: missing user_id");
        return;
    }
    if purpose != "media_video" {
        warn!("Video connection rejected: invalid media ticket purpose '{}'", purpose);
        return;
    }
    if media_role != role {
        warn!(
            "Video connection rejected: media_role claim ({}) does not match requested role ({})",
            media_role, role
        );
        return;
    }
    if (role == "subscribe" || role == "subscribe_overlay") && token_sharer != sharer {
        warn!(
            "Video connection rejected: sharer claim ({}) does not match requested sharer ({})",
            token_sharer, sharer
        );
        return;
    }

    // The token was minted for a specific channel_id at mint time (org membership,
    // group-assignment lock, restricted-mode checks — see orgController.ts
    // getOrgToken). Without this check a token minted for channel A could be
    // replayed against a different channel B's video plane, watching or injecting
    // video into a channel it was never authorized for. Mirrors the identical
    // check already applied to the voice connection path above.
    let token_channel_id = claims.get("channel_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if token_channel_id != channel_id {
        warn!(
            "Video connection rejected: token channel_id ({}) does not match requested channel_id ({})",
            token_channel_id, channel_id
        );
        return;
    }

    let session = match request.accept().await {
        Ok(s) => s,
        Err(e) => { error!("Video session accept failed: {}", e); return; }
    };

    // Publish and subscribe sessions are registered so drain_org can close
    // them (see drain::VideoSessionRegistry); the guard deregisters on every
    // exit path. Registration happens once here, never per frame.
    let session = Arc::new(session);
    if role == "publish" {
        let _drain_guard = node.video_sessions.register(&org_id, Arc::clone(&session));
        handle_video_publish(session, user_id, callsign, channel_id, rooms).await;
    } else if role == "subscribe" {
        let _drain_guard = node.video_sessions.register(&org_id, Arc::clone(&session));
        let audio_delivery = ShareAudioDelivery::from_params(wants_share_audio, wants_share_audio_dgram);
        handle_video_subscribe(session, user_id, callsign.clone(), sharer, channel_id, org_id, rooms, nats, audio_delivery, node).await;
    } else if role == "subscribe_overlay" {
        drop(session);
        handle_video_overlay_subscribe(callsign, sharer).await;
    } else {
        warn!("Video connection rejected: unknown role {}", role);
    }
}

async fn handle_video_publish(
    session: Arc<wtransport::Connection>,
    user_id: String,
    callsign: String,
    channel_id: String,
    rooms: RoomRegistry,
) {
    info!("Video publish: '{}' ({}) starting share in channel '{}'", callsign, user_id, channel_id);
    let (video_ctrl_tx, video_streams, video_sharers, video_headers, video_keyframes,
         video_activation_senders, video_publish_nonces, video_keyframe_requests) = {
        let rooms_read = rooms.read().await;
        if let Some(room) = rooms_read.get(&channel_id) {
            (
                room.video_ctrl_tx.clone(),
                room.video_streams.clone(),
                room.video_sharers.clone(),
                room.video_headers.clone(),
                room.video_keyframes.clone(),
                room.video_activation_senders.clone(),
                room.video_publish_nonces.clone(),
                room.video_keyframe_requests.clone(),
            )
        } else {
            warn!("Video publish: channel '{}' has no room on this node (publisher='{}' {})", channel_id, callsign, user_id);
            return;
        }
    };

    // Claim this publish slot with a fresh nonce so cleanup at the end of this
    // function can tell whether it's still the live session (see
    // video_publish_nonces' doc comment on RoomState).
    let publish_nonce = SESSION_NONCE.fetch_add(1, Ordering::Relaxed);
    video_publish_nonces.write().await.insert(user_id.clone(), publish_nonce);

    // This sharer's own broadcast channel — created here (not at room-creation
    // time) since it only needs to exist while this sharer is actively publishing.
    // Registered into video_streams right after video_headers below so any
    // concurrent handle_video_subscribe that finds this sharer via video_sharers
    // is guaranteed to also find its channel.
    let (my_video_tx, _) = broadcast::channel::<(bytes::Bytes, Instant)>(512);
    // This sharer's share audio, from either transport (share_audio.rs).
    let (my_audio_tx, _) = broadcast::channel::<(bytes::Bytes, Instant)>(share_audio::SHARE_AUDIO_CHANNEL_CAPACITY);

    // Create a per-sharer activation watch channel (starts at 0 viewers = inactive).
    // Must be inserted BEFORE video_headers/video_sharers so any concurrent
    // handle_video_subscribe always finds the sender when the sharer is visible.
    let (act_tx, act_rx) = watch::channel::<u32>(0);
    video_activation_senders.write().await.insert(user_id.clone(), act_tx);

    // Spawn task that signals the publisher client to activate/deactivate streaming
    // based on viewer count transitions (0→1 = activate, last→0 = deactivate).
    let session_for_act = Arc::clone(&session);
    let act_task = tokio::spawn(async move {
        // First signals of every publish session: this server filters share
        // audio per subscriber, so the publisher may multiplex it in (0x41),
        // and it also takes share audio as datagrams on this session (0x44).
        // A 2.0.6–2.0.8 publisher knows only the first; a newer one prefers
        // datagrams and falls back to in-stream on a server that sends only 0x41.
        for signal in [SHARE_AUDIO_CAPABLE, SHARE_AUDIO_DGRAM_CAPABLE] {
            if let Ok(opening) = session_for_act.open_uni().await {
                if let Ok(mut stream) = opening.await {
                    let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, &[signal]).await;
                }
            }
        }
        let mut act_rx = act_rx;
        let mut last_active = false;
        loop {
            if act_rx.changed().await.is_err() { break; }
            let count = *act_rx.borrow_and_update();
            let active = count > 0;
            if active != last_active {
                last_active = active;
                let byte = if active { 0xACu8 } else { 0xDEu8 };
                if let Ok(opening) = session_for_act.open_uni().await {
                    if let Ok(mut stream) = opening.await {
                        let _ = tokio::io::AsyncWriteExt::write_all(&mut stream, &[byte]).await;
                    }
                }
            }
        }
    });

    // Keyframe requests for this sharer (see video_keyframe_requests and
    // run_keyframe_request_relay). Same lifetime and registration point as the
    // activation sender above, so a subscriber that finds this sharer always
    // finds its request queue too.
    let (kf_req_tx, kf_req_rx) = mpsc::channel::<Instant>(KEYFRAME_REQUEST_QUEUE);
    video_keyframe_requests.write().await.insert(user_id.clone(), kf_req_tx);
    let kf_req_task = tokio::spawn(run_keyframe_request_relay(
        Arc::clone(&session), kf_req_rx, video_keyframes.clone(), user_id.clone(), callsign.clone(),
    ));

    // Share audio as datagrams on this publish session (SHARE_AUDIO_DGRAM_CAPABLE).
    // Nothing else reads this session's datagrams. Validated, rate-limited,
    // turned into the in-stream frame once, and broadcast on the sharer's audio
    // channel. Before the header is in (no subscribers yet) the send just fails.
    let dgram_task = tokio::spawn(run_share_audio_datagram_ingress(
        Arc::clone(&session), my_audio_tx.clone(), callsign.clone(),
    ));

    // NOTE: video_sharers.insert is intentionally deferred until AFTER
    // video_headers.insert below.  Any lookup of video_sharers (e.g., the
    // new-joiner snapshot announce or handle_video_subscribe) will therefore
    // always find a valid header when the callsign is present.

    let mut stream = match tokio::time::timeout(
        std::time::Duration::from_secs(10),
        session.accept_uni(),
    ).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            warn!("Video publish: accept_uni() error for '{}': {}", callsign, e);
            act_task.abort();
            kf_req_task.abort();
            dgram_task.abort();
            // Nonce-gated for the same reason as the end-of-function cleanup below:
            // a reconnect within this 10s window may have already claimed a new
            // nonce and inserted its own act_tx for this user_id — an unconditional
            // remove here would delete the new session's entry instead of this
            // (already-failed) one's.
            let mut nonces = video_publish_nonces.write().await;
            if nonces.get(&user_id).copied() == Some(publish_nonce) {
                nonces.remove(&user_id);
                drop(nonces);
                video_activation_senders.write().await.remove(&user_id);
                video_keyframe_requests.write().await.remove(&user_id);
            }
            return;
        }
        Err(_) => {
            warn!("Video publish: timed out waiting for header stream from '{}'", callsign);
            act_task.abort();
            kf_req_task.abort();
            dgram_task.abort();
            let mut nonces = video_publish_nonces.write().await;
            if nonces.get(&user_id).copied() == Some(publish_nonce) {
                nonces.remove(&user_id);
                drop(nonces);
                video_activation_senders.write().await.remove(&user_id);
                video_keyframe_requests.write().await.remove(&user_id);
            }
            return;
        }
    };

    let mut type_byte = [0u8; 1];
    if tokio::io::AsyncReadExt::read_exact(&mut stream, &mut type_byte).await.is_err() || type_byte[0] != 0x02 {
        warn!("Video publish: bad or missing type byte from '{}' (got {})", callsign, type_byte[0]);
    } else {
        let mut hlen_buf = [0u8; 4];
        if tokio::io::AsyncReadExt::read_exact(&mut stream, &mut hlen_buf).await.is_ok() {
            let header_len = u32::from_be_bytes(hlen_buf) as usize;
            if header_len > MAX_VIDEO_HEADER_LEN {
                warn!("Video publish: header_len {} from '{}' exceeds {}-byte cap", header_len, callsign, MAX_VIDEO_HEADER_LEN);
            }
            if header_len <= MAX_VIDEO_HEADER_LEN {
            let mut header_bytes = vec![0u8; header_len];
            if tokio::io::AsyncReadExt::read_exact(&mut stream, &mut header_bytes).await.is_ok() {
                let mut header_blob = Vec::with_capacity(4 + header_len);
                header_blob.extend_from_slice(&hlen_buf);
                header_blob.extend_from_slice(&header_bytes);
                // Insert header first, then register as sharer so any concurrent
                // handle_video_subscribe or new-joiner snapshot always sees the header.
                video_headers.write().await.insert(user_id.clone(), header_blob);
                video_streams.write().await.insert(user_id.clone(), ShareStreamTx {
                    video: my_video_tx.clone(),
                    audio: my_audio_tx.clone(),
                });
                let sharer_count = {
                    let mut sharers = video_sharers.write().await;
                    sharers.insert(user_id.clone(), callsign.clone());
                    sharers.len()
                };
                if sharer_count > 1 {
                    // Visibility only — no throttling/behavior change here. Gives real
                    // data on how often concurrent publishers occur in a room, ahead of
                    // any future load-aware bitrate governance work.
                    info!(
                        "Room {}: {} simultaneous video publishers active ('{}' just joined)",
                        channel_id, sharer_count, callsign
                    );
                }

                // The 2.0.x client opens a second uni stream (0x03) right after
                // this one and uploads every encoded frame on it a second time —
                // byte-for-byte the same NALs, re-encrypted, and not gated on
                // viewers (so with nobody watching it's the bulk of the upload).
                // It was a "simulcast low-res overlay" once; the client stopped
                // subscribing to it in 1.6.76 and the low-res encoder is long
                // gone, so it reaches nobody. Accept it and STOP_SENDING it:
                // the old client's writes then fail fast (its send pump and
                // header write swallow the error), so it stops costing upload
                // or ingress at all. 2.1+ clients never open it, and this
                // accept just times out.
                let overlay_task = {
                    let session2 = std::sync::Arc::clone(&session);
                    let callsign2 = callsign.clone();
                    tokio::spawn(async move {
                        let ov_stream = match tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            session2.accept_uni()
                        ).await {
                            Ok(Ok(s)) => s,
                            _ => return, // 2.1+ client: no overlay stream
                        };
                        ov_stream.stop(wtransport::VarInt::from_u32(0));
                        info!("Video publish: refused legacy overlay stream from '{}'", callsign2);
                    })
                };

                // Now that header is cached and sharer is visible, announce.
                let mut sig = vec![0xFF, 0x01, 1];
                sig.extend_from_slice(callsign.as_bytes());
                let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));

                // Read and relay complete frames one at a time so each broadcast
                // message contains exactly one [4B size][1B type][4B ts][data] unit.
                // Broadcasting raw read() chunks instead would let a message
                // contain partial or multiple frames, causing the subscriber
                // to lag then flush on network buffer boundaries.
                let mut large_frame_window_start = Instant::now();
                let mut large_frame_count: u32 = 0;
                // In-stream share audio (a 2.0.6–2.0.8 sharer) gets the same
                // limit as datagram audio.
                let mut audio_limiter = ShareAudioRateLimiter::new(Instant::now());
                loop {
                    // Read 4-byte frame size header
                    let mut size_buf = [0u8; 4];
                    match tokio::io::AsyncReadExt::read_exact(&mut stream, &mut size_buf).await {
                        Ok(_) => {}
                        Err(_) => break,
                    }
                    let frame_size = u32::from_be_bytes(size_buf) as usize;
                    if frame_size == 0 { break; }
                    // Sanity cap: 25 MB max frame (1080p IDR with SPS/PPS)
                    if frame_size > 25_000_000 { break; }

                    if frame_size > LARGE_VIDEO_FRAME_THRESHOLD {
                        if large_frame_window_start.elapsed() > LARGE_VIDEO_FRAME_WINDOW {
                            large_frame_window_start = Instant::now();
                            large_frame_count = 0;
                        }
                        large_frame_count += 1;
                        if large_frame_count > MAX_LARGE_VIDEO_FRAMES_PER_WINDOW {
                            warn!("Video publish: '{}' sent {} frames over {}B within {:?} — dropping connection",
                                callsign, large_frame_count, LARGE_VIDEO_FRAME_THRESHOLD, LARGE_VIDEO_FRAME_WINDOW);
                            break;
                        }
                    }

                    // Read full frame body
                    let mut frame_body = vec![0u8; frame_size];
                    match tokio::io::AsyncReadExt::read_exact(&mut stream, &mut frame_body).await {
                        Ok(_) => {}
                        Err(_) => break,
                    }

                    // Compose framed packet: [4B size][body]
                    let mut framed = Vec::with_capacity(4 + frame_size);
                    framed.extend_from_slice(&size_buf);
                    framed.extend_from_slice(&frame_body);
                    let framed_bytes = bytes::Bytes::from(framed);

                    let arrived_at = Instant::now();
                    // Share audio sent in-stream goes on the audio channel too, so
                    // every subscriber gets it in the form it asked for.
                    if frame_body.first().copied().is_some_and(share_frame_is_audio) {
                        if audio_limiter.allow(arrived_at) {
                            let _ = my_audio_tx.send((framed_bytes, arrived_at));
                        } else if audio_limiter.dropped == 1 || audio_limiter.dropped % 500 == 0 {
                            warn!("Video publish: '{}' over the share-audio rate limit ({} in-stream packets dropped)", callsign, audio_limiter.dropped);
                        }
                        continue;
                    }

                    // Update keyframe cache if this is an IDR (flags bit 0 clear)
                    if frame_body.first().copied().is_some_and(video_flags_is_keyframe) {
                        video_keyframes.write().await.insert(user_id.clone(), (framed_bytes[..].to_vec(), arrived_at));
                    }

                    // Broadcast exactly one complete frame
                    let _ = my_video_tx.send((framed_bytes, arrived_at));
                }
                // Main relay loop exited — abort the overlay task (if it is
                // still waiting) so nothing outlives the session.
                overlay_task.abort();
            }
            }
        }
    }
    // Every exit path from here on: stop the activation and keyframe-request
    // tasks before they write into a dismantled RoomState / closed session.
    act_task.abort();
    kf_req_task.abort();
    dgram_task.abort();

    // Only tear down shared state if our nonce still matches — a mismatch means
    // a reconnect already re-registered this user's video publish (new
    // video_publish_nonces entry, new video_headers/video_streams/etc.) before
    // this old session's cleanup got here, so clearing now would wipe the live
    // stream and falsely broadcast "sharer left" out from under it.
    //
    // Check-and-remove happens under a single write lock, not a read lock
    // followed by a separate write lock — that gap would let a reconnecting
    // session claim a fresh nonce for this user_id between the check and the
    // remove, and an unconditional `.remove()` would then delete the NEW
    // session's nonce entry (remove() doesn't check the value), causing the
    // new session's own cleanup to see a mismatch and skip its teardown —
    // leaking its video_headers/video_streams/etc. state forever.
    let still_current = {
        let mut nonces = video_publish_nonces.write().await;
        if nonces.get(&user_id).copied() == Some(publish_nonce) {
            nonces.remove(&user_id);
            true
        } else {
            false
        }
    };
    if !still_current {
        info!("Video publish cleanup for '{}' skipped — nonce mismatch (reconnect already re-registered).", callsign);
        return;
    }
    video_headers.write().await.remove(&user_id);
    video_keyframes.write().await.remove(&user_id);
    video_activation_senders.write().await.remove(&user_id);
    video_keyframe_requests.write().await.remove(&user_id);
    // Empty-chunk sentinel tells any subscriber still holding a receiver on this
    // sharer's channel to break its loop cleanly, before the channel itself is
    // torn down by removing it from video_streams (dropping the last Sender causes
    // outstanding Receivers to see Closed instead, which subscribers also handle,
    // but this gives them the same clean empty-chunk exit path as before).
    let _ = my_video_tx.send((bytes::Bytes::new(), Instant::now()));
    let _ = my_audio_tx.send((bytes::Bytes::new(), Instant::now()));
    video_streams.write().await.remove(&user_id);
    video_sharers.write().await.remove(&user_id);

    let mut sig = vec![0xFF, 0x01, 0];
    sig.extend_from_slice(callsign.as_bytes());
    let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));
}

/// Relays one sharer's keyframe requests to its publisher, coalesced and
/// rate-limited by KeyframeRequestGate: a burst of requests from any number of
/// viewers (and from the server's own subscriber relays) becomes at most one
/// VIDEO_KEYFRAME_REQUEST per KEYFRAME_REQUEST_MIN_INTERVAL, and none at all
/// once a keyframe newer than the newest request has arrived. Runs for the
/// lifetime of the publish session; handle_video_publish aborts it on exit.
async fn run_keyframe_request_relay(
    session: Arc<wtransport::Connection>,
    mut requests: mpsc::Receiver<Instant>,
    video_keyframes: Arc<RwLock<HashMap<String, (Vec<u8>, Instant)>>>,
    user_id: String,
    callsign: String,
) {
    let mut gate = KeyframeRequestGate::new(KEYFRAME_REQUEST_MIN_INTERVAL);
    let mut forwarded: u64 = 0;
    while let Some(first) = requests.recv().await {
        let mut newest = first;
        loop {
            while let Ok(t) = requests.try_recv() { newest = newest.max(t); }
            let last_keyframe = video_keyframes.read().await.get(&user_id).map(|(_, at)| *at);
            let now = Instant::now();
            match gate.decide(newest, last_keyframe, now) {
                KeyframeGateDecision::AlreadySatisfied => break,
                KeyframeGateDecision::WaitUntil(at) => {
                    tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await;
                }
                KeyframeGateDecision::ForwardNow => {
                    gate.mark_forwarded(now);
                    forwarded += 1;
                    if forwarded == 1 || forwarded % 50 == 0 {
                        info!("Video publish: {} keyframe request(s) forwarded to '{}'", forwarded, callsign);
                    }
                    // Same one-byte uni stream as the activation signals. Bounded
                    // so a publisher that stops granting stream credit can't wedge
                    // this task (later requests just queue up and coalesce).
                    let send = async {
                        let mut stream = session.open_uni().await.ok()?.await.ok()?;
                        tokio::io::AsyncWriteExt::write_all(&mut stream, &[VIDEO_KEYFRAME_REQUEST]).await.ok()
                    };
                    if tokio::time::timeout(Duration::from_secs(2), send).await.ok().flatten().is_none() {
                        debug!("Video publish: keyframe request to '{}' not delivered", callsign);
                    }
                    break;
                }
            }
        }
    }
}

/// Reads share-audio datagrams from one publish session for its lifetime (see
/// share_audio.rs) and broadcasts each valid one as an in-stream frame on the
/// sharer's audio channel. Datagrams of any other type are ignored. Over-limit
/// packets are dropped, not disconnected: an Opus packet is too small to be
/// worth an attack, and the limit only bounds the fan-out work. Aborted by
/// handle_video_publish on exit.
async fn run_share_audio_datagram_ingress(
    session: Arc<wtransport::Connection>,
    audio_tx: ShareAudioTx,
    callsign: String,
) {
    let mut limiter = ShareAudioRateLimiter::new(Instant::now());
    let mut received: u64 = 0;
    let mut logged_drops: u64 = 0;
    while let Ok(dgram) = session.receive_datagram().await {
        let now = Instant::now();
        match share_audio::ingest_datagram(dgram.payload().as_ref(), &mut limiter, now) {
            Some(frame) => {
                received += 1;
                if received == 1 {
                    info!("Video publish: '{}' is sending share audio as datagrams", callsign);
                }
                let _ = audio_tx.send((frame, now));
            }
            None => {
                if limiter.dropped != logged_drops && (limiter.dropped == 1 || limiter.dropped % 500 == 0) {
                    logged_drops = limiter.dropped;
                    warn!("Video publish: '{}' over the share-audio rate limit ({} datagrams dropped)", callsign, limiter.dropped);
                }
            }
        }
    }
}

/// `subscribe_overlay` was the low-res simulcast overlay role. No client has
/// used it since 1.6.76 (the overlay window decodes the main stream, relayed
/// locally), and publishers' overlay streams are now refused (see
/// handle_video_publish), so there is never anything to serve. Kept only so
/// the role is still recognised; the session just closes.
async fn handle_video_overlay_subscribe(subscriber_callsign: String, sharer_callsign: String) {
    info!("Overlay subscribe: '{}' asked for the retired overlay stream of '{}' — ignoring",
        subscriber_callsign, sharer_callsign);
}

async fn handle_video_subscribe(
    session: Arc<wtransport::Connection>,
    subscriber_user_id: String,
     subscriber_callsign: String,
    sharer_callsign: String,
    channel_id: String,
    org_id: String,
    rooms: RoomRegistry,
    nats: Option<async_nats::Client>,
    audio_delivery: ShareAudioDelivery,
    node: Arc<NodeContext>,
) {
    info!("Video subscribe: '{}' wants to watch '{}' in channel '{}' (share audio: {:?})",
        subscriber_callsign, sharer_callsign, channel_id, audio_delivery);
    // Billing meters egress — what the server actually serves to this viewer —
    // not the sharer's single upload, since N viewers of the same stream cost
    // the server N× the bytes. Published once the subscribe session ends.
    let session_start = std::time::Instant::now();
    let mut bytes_sent: u64 = 0;
    let (video_streams, video_ctrl_tx, sharer_uid, video_viewer_count, video_headers, video_keyframes, video_activation_senders, video_keyframe_requests) = {
        let rooms_read = rooms.read().await;
        if let Some(room) = rooms_read.get(&channel_id) {
            let sharers = room.video_sharers.read().await;
            let uid = sharers.iter().find(|(_, cs)| cs.as_str() == sharer_callsign.as_str()).map(|(k, _)| k.clone());
            if let Some(uid) = uid {
                info!("Video subscribe: sharer '{}' ({}) found — forwarding stream to '{}'",
                    sharer_callsign, uid, subscriber_callsign);
                (room.video_streams.clone(), room.video_ctrl_tx.clone(), uid, room.video_viewer_count.clone(), room.video_headers.clone(), room.video_keyframes.clone(), room.video_activation_senders.clone(), room.video_keyframe_requests.clone())
            } else {
                warn!("Video subscribe: sharer '{}' not found in room '{}' (active sharers: {:?})",
                    sharer_callsign, channel_id,
                    sharers.values().collect::<Vec<_>>());
                return;
            }
        } else {
            warn!("Video subscribe: channel '{}' has no room on this node (subscriber='{}', sharer='{}')",
                channel_id, subscriber_callsign, sharer_callsign);
            return;
        }
    };

    let sharer_tx = match video_streams.read().await.get(&sharer_uid).cloned() {
        Some(tx) => tx,
        None => {
            warn!("Video subscribe: '{}' has no active video stream yet", sharer_callsign);
            return;
        }
    };
    let mut video_rx = sharer_tx.video.subscribe();
    // Share audio: this subscriber's receiver on its sharer's audio channel
    // only (so it never sees another sharer's audio), in the form it asked for.
    // Datagram viewers get their own forwarder task (started below, so a
    // stalled video write never delays their audio). In-stream viewers read it
    // in the frame loop. Others never subscribe. Dropping sharer_tx means this
    // subscriber no longer keeps the sharer's channels open.
    let mut audio_rx = match audio_delivery {
        ShareAudioDelivery::None => None,
        _ => Some(sharer_tx.audio.subscribe()),
    };
    drop(sharer_tx);

    // This sharer's keyframe-request queue (None for a sharer whose publish
    // session is mid-teardown). try_send: a full queue already means a forced
    // keyframe is coming, so there's nothing to add.
    let keyframe_requests = video_keyframe_requests.read().await.get(&sharer_uid).cloned();
    let request_keyframe = || {
        if let Some(ref tx) = keyframe_requests { let _ = tx.try_send(Instant::now()); }
    };

    let header_opt = video_headers.read().await.get(&sharer_uid).cloned();
    let keyframe_opt = video_keyframes.read().await.get(&sharer_uid).cloned();
    // The cached keyframe is followed by live frames from the moment we
    // subscribed (video_rx above); the deltas in between are gone. Unless it
    // is (nearly) the latest frame, those deltas would decode against missing
    // references, so ask for a fresh keyframe and hold the deltas back until
    // it arrives — the viewer shows the cached picture meanwhile instead of
    // smearing. Against a 2.0.x publisher (ignores the request) that's at most
    // one GOP of still picture, then the scheduled keyframe.
    let cached_keyframe_stale = keyframe_opt.as_ref().map_or(true, |(_, at)| at.elapsed() > KEYFRAME_CACHE_FRESH);
    info!("Video subscribe: header={}, keyframe={} for subscriber '{}'",
        if header_opt.is_some() { "yes" } else { "MISSING" },
        match &keyframe_opt { None => "MISSING", Some(_) if cached_keyframe_stale => "stale", Some(_) => "fresh" },
        subscriber_callsign);

    info!("Video subscribe: opening uni stream to '{}'...", subscriber_callsign);
    let opening = match session.open_uni().await {
        Ok(o) => o,
        Err(e) => { warn!("Video subscribe: open_uni() failed for '{}': {}", subscriber_callsign, e); return; }
    };
    info!("Video subscribe: awaiting uni stream ready for '{}'...", subscriber_callsign);
    let mut stream = match opening.await {
        Ok(s) => s,
        Err(e) => { warn!("Video subscribe: opening.await failed for '{}': {}", subscriber_callsign, e); return; }
    };
    info!("Video subscribe: uni stream ready, writing prefix to '{}'", subscriber_callsign);

    // Activate the publisher and count this viewer only now that the stream is
    // actually open. Doing this before open_uni()/opening.await would mean
    // either one failing (both early-return above) leaks the increment
    // forever with no matching decrement, permanently inflating
    // video_viewer_count and potentially leaving the publisher's activation
    // task stuck "active". The publisher's activation task sees the 0→1
    // transition and starts full streaming.
    if let Some(act_tx) = video_activation_senders.read().await.get(&sharer_uid) {
        act_tx.send_modify(|v| *v += 1);
    }
    let new_count = video_viewer_count.fetch_add(1, Ordering::Relaxed) + 1;
    let mut sig = vec![0xFF, 0x04, 0, 0, 0, 0];
    sig[2..6].copy_from_slice(&(new_count as u32).to_be_bytes());
    let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));

    let mut prefix: Vec<u8> = vec![0x02];
    if let Some(ref h) = header_opt { prefix.extend_from_slice(h); }
    if let Some((ref kf, _)) = keyframe_opt { prefix.extend_from_slice(kf); }
    if cached_keyframe_stale { request_keyframe(); }

    let audio_bytes_out = Arc::new(AtomicU64::new(0));
    let mut audio_dgram_task = None;
    if audio_delivery == ShareAudioDelivery::Datagram {
        if let Some(rx) = audio_rx.take() {
            let session_a = Arc::clone(&session);
            let bytes_a = Arc::clone(&audio_bytes_out);
            let cs = subscriber_callsign.clone();
            audio_dgram_task = Some(tokio::spawn(async move {
                let stats = share_audio::forward_datagrams(
                    rx,
                    |d| session_a.send_datagram(d).map_err(share_audio::DatagramSendError::from),
                    &bytes_a,
                ).await;
                if stats.sent > 0 || stats.rejected > 0 {
                    info!("Video subscribe: share audio to '{}': {} datagrams, {} stale, {} rejected, {} lagged",
                        cs, stats.sent, stats.stale, stats.rejected, stats.lagged);
                }
            }));
        }
    }

    if stream.write_all(&prefix).await.is_ok() {
        bytes_sent += prefix.len() as u64;
        info!("Video subscribe: prefix written ({} bytes), entering frame loop for '{}'", prefix.len(), subscriber_callsign);
        let mut frames_sent: u64 = 0;
        let mut viewer_requests: u64 = 0;
        // Set on a Lagged overflow or a stale delta frame; cleared once a keyframe
        // arrives. While set, every non-keyframe chunk is dropped rather than
        // written, since a P-frame relayed after a gap would reference frames the
        // decoder never saw and corrupt decode until the next keyframe anyway.
        // Every false→true transition asks the sharer for that keyframe now
        // instead of waiting out the GOP (the request relay rate-limits it).
        let mut needs_resync = cached_keyframe_stale;
        loop {
            tokio::select! {
                vdata = video_rx.recv() => {
                    match vdata {
                        Ok((chunk, produced_at)) => {
                            if chunk.is_empty() { break; }
                            // Share audio never comes on this channel any more
                            // (handle_video_publish routes it to the audio one).
                            // This guard stays as a backstop: a 2.0.0–2.0.5
                            // viewer's decoder must never see an audio frame.
                            if chunk.len() > 4 && share_frame_is_audio(chunk[4]) { continue; }
                            // Keyframe: flags byte is at offset 4 (after 4-byte size header)
                            let is_keyframe = chunk.len() > 4 && video_flags_is_keyframe(chunk[4]);
                            if needs_resync {
                                if !is_keyframe { continue; }
                                needs_resync = false;
                            } else if !is_keyframe && produced_at.elapsed() > MAX_VIDEO_FRAME_AGE {
                                // Already too stale to bother writing — a slow write here would
                                // only let us fall further behind. Drop it (and the rest of this
                                // GOP) instead of waiting for the broadcast channel to overflow.
                                needs_resync = true;
                                request_keyframe();
                                continue;
                            }
                            if stream.write_all(&chunk).await.is_err() { break; }
                            bytes_sent += chunk.len() as u64;
                            frames_sent += 1;
                            if frames_sent == 1 || frames_sent % 100 == 0 {
                                info!("Video subscribe: {} frames relayed to '{}'", frames_sent, subscriber_callsign);
                            }
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("Video subscribe: '{}' lagged by {} frames — skipping to next keyframe", subscriber_callsign, n);
                            if !needs_resync { request_keyframe(); }
                            needs_resync = true;
                        }
                        Err(_) => break,
                    }
                }
                // In-stream share audio (2.0.6–2.0.8 viewers). Never gated on, and
                // never able to trigger, the video resync above: audio keeps
                // playing while video waits for a keyframe.
                adata = share_audio::recv_opt(&mut audio_rx) => {
                    match adata {
                        Ok((chunk, produced_at)) => {
                            if chunk.is_empty() { audio_rx = None; continue; }
                            if produced_at.elapsed() > MAX_SHARE_AUDIO_AGE { continue; }
                            if stream.write_all(&chunk).await.is_err() { break; }
                            bytes_sent += chunk.len() as u64;
                        }
                        Err(broadcast::error::RecvError::Lagged(_)) => {}
                        Err(_) => audio_rx = None,
                    }
                }
                // The viewer's own resync points (decode queue overflow, decoder
                // reset, its overlay/strip viewer taking over) — see
                // VIDEO_KEYFRAME_REQUEST. Anything else on this session's
                // datagram channel is ignored.
                datagram = session.receive_datagram() => {
                    match datagram {
                        Ok(dgram) => {
                            if dgram.payload().first() == Some(&VIDEO_KEYFRAME_REQUEST) {
                                viewer_requests += 1;
                                if viewer_requests == 1 || viewer_requests % 50 == 0 {
                                    info!("Video subscribe: '{}' has requested {} keyframe(s)", subscriber_callsign, viewer_requests);
                                }
                                request_keyframe();
                            }
                        }
                        Err(_) => break, // connection gone
                    }
                }
                _ = session.closed() => {
                    info!("Video subscribe: session closed for '{}' after {} frames", subscriber_callsign, frames_sent);
                    break;
                }
            }
        }
    } else {
        warn!("Video subscribe: prefix write_all failed for '{}'", subscriber_callsign);
    }
    if let Some(task) = audio_dgram_task { task.abort(); }
    bytes_sent += audio_bytes_out.load(Ordering::Relaxed);

    let prev = video_viewer_count.fetch_sub(1, Ordering::Relaxed);
    let new_count = prev.saturating_sub(1);
    let mut sig = vec![0xFF, 0x04, 0, 0, 0, 0];
    sig[2..6].copy_from_slice(&(new_count as u32).to_be_bytes());
    let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));

    // Deactivate publisher if this was the last viewer for this specific sharer.
    if let Some(act_tx) = video_activation_senders.read().await.get(&sharer_uid) {
        act_tx.send_modify(|v| *v = v.saturating_sub(1));
    };

    if let Some(ref n) = nats {
        if !org_id.is_empty() {
            let dur = session_start.elapsed().as_secs();
            let p = crate::nats::to_payload(&crate::nats::SessionEnd {
                org_id: &org_id, user_id: &subscriber_user_id, channel_id: &channel_id,
                duration_secs: dur, bytes_out: bytes_sent, superseded: None,
                node_id: &node.node_id,
            });
            let _ = n.publish(node.session_end_subject.clone(), p).await;
        }
    }
}


// E2EV: version-gate parsing (cargo test).
#[cfg(test)]
mod e2ev_tests {
    use super::*;

    #[test]
    fn semver_parse_and_gate() {
        assert_eq!(parse_semver("2.0.0"), Some((2, 0, 0)));
        assert_eq!(parse_semver("v2.1.3-beta.1"), Some((2, 1, 3)));
        assert_eq!(parse_semver("1.10.46"), Some((1, 10, 46)));
        assert_eq!(parse_semver(""), None);
        assert_eq!(parse_semver("2.0"), None);
        assert_eq!(parse_semver("2.0.0.1"), None);
        assert_eq!(parse_semver("x.y.z"), None);
        // Default minimum 2.0.0 (MIN_RELAY_CLIENT_VERSION unset in tests).
        if std::env::var("MIN_RELAY_CLIENT_VERSION").is_err() {
            assert!(client_version_ok("2.0.0"));
            assert!(client_version_ok("2.0.1"));
            assert!(client_version_ok("10.0.0"));
            assert!(!client_version_ok("1.10.46"));
            assert!(!client_version_ok("1.99.99"));
            assert!(!client_version_ok(""));
            assert!(!client_version_ok("garbage"));
        }
    }

    #[test]
    fn listen_only_claim_is_opt_in_and_bool_only() {
        let mut c = Claims::new();
        assert!(!ticket_listen_only(&c), "tickets without the claim stay two-way");
        c.insert("listen_only".into(), serde_json::json!(false));
        assert!(!ticket_listen_only(&c));
        c.insert("listen_only".into(), serde_json::json!("true"));
        assert!(!ticket_listen_only(&c), "only a JSON bool counts");
        c.insert("listen_only".into(), serde_json::json!(true));
        assert!(ticket_listen_only(&c));
    }
}

// Share-audio flags vs the keyframe test (cargo test).
#[cfg(test)]
mod share_audio_flag_tests {
    use super::*;

    #[test]
    fn audio_frames_are_never_keyframes_and_video_is_never_audio() {
        // Video as every client has always sent it.
        assert!(video_flags_is_keyframe(0x00) && !share_frame_is_audio(0x00));
        assert!(!video_flags_is_keyframe(0x01) && !share_frame_is_audio(0x01));
        // Share audio (web-portal/src/engine/shareAudio.js SHARE_AUDIO_FLAGS).
        assert!(share_frame_is_audio(0x05));
        assert!(!video_flags_is_keyframe(0x05), "an audio frame must never be cached as the keyframe");
    }
}

// Keyframe-request coalescing / rate limiting (cargo test).
#[cfg(test)]
mod keyframe_request_tests {
    use super::*;

    const MIN: Duration = Duration::from_millis(400);
    fn ms(base: Instant, n: u64) -> Instant { base + Duration::from_millis(n) }

    #[test]
    fn first_request_is_forwarded_immediately() {
        let gate = KeyframeRequestGate::new(MIN);
        let t0 = Instant::now();
        assert_eq!(gate.decide(t0, None, t0), KeyframeGateDecision::ForwardNow);
        // A keyframe from before the request doesn't answer it.
        assert_eq!(gate.decide(ms(t0, 10), Some(t0), ms(t0, 10)), KeyframeGateDecision::ForwardNow);
    }

    #[test]
    fn requests_inside_the_window_wait_for_its_end() {
        let mut gate = KeyframeRequestGate::new(MIN);
        let t0 = Instant::now();
        gate.mark_forwarded(t0);
        assert_eq!(gate.decide(ms(t0, 50), None, ms(t0, 50)), KeyframeGateDecision::WaitUntil(ms(t0, 400)));
        assert_eq!(gate.decide(ms(t0, 399), None, ms(t0, 399)), KeyframeGateDecision::WaitUntil(ms(t0, 400)));
        assert_eq!(gate.decide(ms(t0, 399), None, ms(t0, 400)), KeyframeGateDecision::ForwardNow);
    }

    #[test]
    fn a_newer_keyframe_answers_pending_requests() {
        let mut gate = KeyframeRequestGate::new(MIN);
        let t0 = Instant::now();
        gate.mark_forwarded(t0);
        // The forced keyframe lands at +60 ms; a request made at +20 ms (before
        // it arrived) is answered by it and must not trigger a second one.
        assert_eq!(gate.decide(ms(t0, 20), Some(ms(t0, 60)), ms(t0, 400)), KeyframeGateDecision::AlreadySatisfied);
        // ...but a request made after that keyframe still needs its own.
        assert_eq!(gate.decide(ms(t0, 70), Some(ms(t0, 60)), ms(t0, 400)), KeyframeGateDecision::ForwardNow);
        // A scheduled (GOP) keyframe answers requests just the same.
        let fresh = KeyframeRequestGate::new(MIN);
        assert_eq!(fresh.decide(ms(t0, 5), Some(ms(t0, 5)), ms(t0, 6)), KeyframeGateDecision::AlreadySatisfied);
    }

    #[tokio::test]
    async fn many_requesters_produce_at_most_one_keyframe_per_interval() {
        // Drive the gate the way run_keyframe_request_relay does (minus the
        // network): 10 viewers each asking every 50 ms for ~2 s, and an old
        // publisher that never answers. Real time (the gate reads std
        // Instants), so this takes ~2 s. Must forward ≤ 1 per MIN interval.
        let (tx, mut rx) = mpsc::channel::<Instant>(KEYFRAME_REQUEST_QUEUE);
        let producer = tokio::spawn(async move {
            for _ in 0..40 {
                for _ in 0..10 { let _ = tx.try_send(Instant::now()); }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        });
        let mut gate = KeyframeRequestGate::new(MIN);
        let mut forwarded: Vec<Instant> = Vec::new();
        while let Some(first) = rx.recv().await {
            let mut newest = first;
            loop {
                while let Ok(t) = rx.try_recv() { newest = newest.max(t); }
                let now = Instant::now();
                match gate.decide(newest, None, now) {
                    KeyframeGateDecision::AlreadySatisfied => break,
                    KeyframeGateDecision::WaitUntil(at) => tokio::time::sleep_until(tokio::time::Instant::from_std(at)).await,
                    KeyframeGateDecision::ForwardNow => { gate.mark_forwarded(now); forwarded.push(now); break; }
                }
            }
        }
        producer.await.unwrap();
        // 400 requests over the run; the bound is one per MIN window (+1 for
        // the very first), measured against the actual run length since
        // timer granularity stretches the producer's sleeps.
        let span = *forwarded.last().unwrap() - forwarded[0];
        let bound = (span.as_millis() / MIN.as_millis()) as usize + 1;
        assert!(forwarded.len() >= 3 && forwarded.len() <= bound, "forwarded {} over {:?}", forwarded.len(), span);
        for pair in forwarded.windows(2) {
            assert!(pair[1] - pair[0] >= MIN, "two forced keyframes {:?} apart", pair[1] - pair[0]);
        }
    }
}
