use wtransport::{Endpoint, ServerConfig, Identity};
use log::{info, error, warn, debug};
use hmac::{Hmac, Mac};
use jwt::VerifyWithKey;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, AtomicU64, AtomicUsize, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock, broadcast, mpsc, watch};
use std::collections::{HashMap, HashSet};
use std::env;
use serde::Serialize;
use serde_json::Value;
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

const DEFAULT_NATS_URL: &str = "nats://localhost:4222";

/// `verify_with_key` only checks the HMAC signature — it does not check the `exp`
/// claim at all. identity-node mints media tokens with a deliberate short lifetime
/// (5 min for channel tokens) as the actual access-control boundary; without this
/// check that lifetime is meaningless and a captured/replayed token works forever.
/// Fails closed: a token with no `exp` claim is treated as expired.
fn is_token_expired(claims: &BTreeMap<String, Value>) -> bool {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    match claims.get("exp").and_then(|v| v.as_u64()) {
        Some(exp) => now >= exp,
        None => true,
    }
}

/// A delta (non-keyframe) video chunk older than this by the time a subscriber's
/// relay task gets to it is dropped rather than written. Without this, a
/// subscriber whose stream write is stalling (slow/congested downlink) just
/// silently backs up in the broadcast channel until it overflows (512 frames,
/// ~20s at 24fps) and only then resyncs — this bounds that worst case to a
/// fraction of a second, mirroring the outgoing-audio-queue max-age bound.
const MAX_VIDEO_FRAME_AGE: Duration = Duration::from_millis(300);

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
    Leave(String),
    Move(String), // new_channel_id
    Speaking { callsign: String, level: u8 },
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
    /// Users whose role grants priority (Commander-tier) — set on join.
    pub priority_users: HashSet<String>,
    /// user_id of the currently active priority speaker (if any).
    pub priority_speaker: Option<String>,
    /// Instant at which ducking should be released.
    pub priority_release_at: Option<Instant>,
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
    pub video_streams: Arc<RwLock<HashMap<String, broadcast::Sender<(bytes::Bytes, Instant)>>>>,
    /// Number of users currently subscribed to watch the active screen share.
    pub video_viewer_count: Arc<AtomicU32>,
    /// All users currently sharing their screen: user_id -> callsign.
    pub video_sharers: Arc<RwLock<HashMap<String, String>>>,
    /// Cached stream header per active sharer: user_id -> [4B len][header JSON].
    /// Replayed to subscribers that join after the stream has already started.
    pub video_headers: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    /// Most recent keyframe per active sharer: user_id -> framed keyframe packet.
    /// Sent to subscribers immediately after the header so VideoDecoder gets a
    /// sync point without waiting up to 2 s for the next periodic keyframe.
    pub video_keyframes: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    /// Per-sharer overlay (simulcast) video relay — same per-sharer rationale as
    /// video_streams above.
    pub video_overlay_streams: Arc<RwLock<HashMap<String, broadcast::Sender<(bytes::Bytes, Instant)>>>>,
    /// Cached overlay stream header per active sharer: user_id -> [4B len][header JSON].
    pub video_overlay_headers: Arc<RwLock<HashMap<String, Vec<u8>>>>,
    /// Most recent overlay keyframe per active sharer: user_id -> framed keyframe packet.
    pub video_overlay_keyframes: Arc<RwLock<HashMap<String, Vec<u8>>>>,
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
                Some(state) => !state.priority_users.is_empty() || state.priority_speaker.is_some(),
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
            for uid in &state.priority_users {
                if let Some(pcm) = pcm_buffers.get(uid) {
                    if is_speaking(pcm, 500.0) { found_speaker = Some(uid.clone()); break; }
                }
            }

            if let Some(ref speaker_id) = found_speaker {
                let is_newly_ducking = state.priority_speaker.is_none();
                state.priority_speaker = Some(speaker_id.clone());
                state.priority_release_at = Some(Instant::now() + Duration::from_millis(1500));

                let priority_snap = state.priority_users.clone();
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
                            format!("specter.cmd.duck.{}", room_id),
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    // No insecure fallback: refuse to start rather than silently accept
    // forgeable tokens signed with a default secret.
    let jwt_secret = Arc::new(match env::var("JWT_SECRET") {
        Ok(s) if !s.is_empty() => s,
        _ => {
            error!("JWT_SECRET is not set — refusing to start with an insecure default. Set JWT_SECRET in the environment.");
            std::process::exit(1);
        }
    });
    let nats_url   = env::var("NATS_URL").unwrap_or_else(|_| DEFAULT_NATS_URL.to_string());
    // Phase A of multi-tenant infra: node identity used by the capacity heartbeat below.
    // Defaults keep today's single-node deployment working with zero required config.
    let node_id    = env::var("NODE_ID").unwrap_or_else(|_| "node-1".to_string());
    let region     = env::var("REGION").unwrap_or_else(|_| "default".to_string());
    // Phase B: optional NATS auth token, needed once NATS is reachable beyond
    // loopback (VPC-private binding for a second node). Deliberately optional,
    // not fail-closed like JWT_SECRET — this flows in ahead of the NATS server
    // actually requiring auth (a one-time manual VPC migration + compose change
    // not yet done), so treating it as mandatory here would break every deploy
    // in the meantime. Once the server-side --auth flag is turned on, an unset/
    // wrong token here will simply fail to connect (visible in logs), same as
    // any other bad credential — no separate hard-fail needed.
    let nats_auth_token = env::var("NATS_AUTH_TOKEN").ok().filter(|s| !s.is_empty());
    if nats_auth_token.is_none() {
        // Not fail-closed (see comment above) — but anyone who can publish to
        // specter.cmd.> today can kick/mute/move any user in any room, since
        // handle_nats_commands trusts every message on that subject at face
        // value with no additional per-message check. Loud on purpose so this
        // doesn't stay a silent gap once NATS is reachable beyond loopback.
        warn!("NATS_AUTH_TOKEN is not set — the NATS command bus (kick/mute/unmute/move) is unauthenticated. Safe only while NATS is loopback-only; set this before exposing NATS beyond a single node (see docs/PHASE_B_ACTIVATION_CHECKLIST).");
    }

    info!("Starting Specter Media SFU (WebTransport + Server-Side Mixing)...");

    // ── 1. Connect to NATS ────────────────────────────────────────────────────
    info!("Connecting to NATS at {}...", nats_url);
    let nats_connect_result = match &nats_auth_token {
        Some(token) => async_nats::ConnectOptions::new().token(token.clone()).connect(&nats_url).await,
        None => async_nats::connect(&nats_url).await,
    };
    let nats_client = match nats_connect_result {
        Ok(client) => { info!("Connected to NATS!"); Some(client) }
        Err(e)     => { warn!("NATS unavailable ({}). Continuing without remote commands.", e); None }
    };

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
        tokio::spawn(async move {
            handle_nats_commands(nats_clone, sessions_clone, rooms_clone, move_senders_clone, tree_clone).await;
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
                    nats_clone.request("specter.event.tree.request", bytes::Bytes::new()),
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

    let identity = match (env::var("TLS_CERT"), env::var("TLS_KEY")) {
        (Ok(cert_path), Ok(key_path)) => {
            info!("Loading TLS from {}, {}", cert_path, key_path);
            Identity::load_pemfiles(&cert_path, &key_path).await
                .expect("Failed to load TLS PEM files")
        }
        _ => {
            warn!("TLS_CERT/TLS_KEY not set — using self-signed cert (dev only)");
            Identity::self_signed(["localhost", "127.0.0.1", "::1"]).unwrap()
        }
    };

    let config = ServerConfig::builder()
        .with_bind_default(port)
        .with_identity(&identity)
        .keep_alive_interval(Some(Duration::from_secs(1)))
        .max_idle_timeout(None)
        .expect("valid idle timeout")
        .build();

    let server = Endpoint::server(config)?;
    info!("Listening on UDP :{}", port);

    // ── 5. Heartbeat publisher ────────────────────────────────────────────────
    // Also serves as the Phase A capacity heartbeat consumed by identity-node's
    // discovery.ts to populate media_nodes — payload must be rebuilt every tick
    // (not built once like the old single-URL-only version) since the capacity
    // counts are live.
    if let Some(nats_clone) = nats_client.clone() {
        let public_url = env::var("PUBLIC_URL")
            .unwrap_or_else(|_| format!("https://localhost:{}", port));
        let rooms_clone = rooms.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(5));
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
            loop {
                interval.tick().await;

                // Sum live capacity across all rooms. Nesting the per-room
                // video_sharers read-lock inside the rooms read-lock mirrors the
                // existing pattern used elsewhere (e.g. handle_video_publish's
                // overlay task) — no new lock-ordering risk.
                let (voice_sessions, video_viewers, video_sharers) = {
                    let rooms_guard = rooms_clone.read().await;
                    let mut voice = 0usize;
                    let mut viewers = 0usize;
                    let mut sharers = 0usize;
                    for room in rooms_guard.values() {
                        voice   += room.members.len();
                        viewers += room.video_viewer_count.load(Ordering::Relaxed) as usize;
                        sharers += room.video_sharers.read().await.len();
                    }
                    (voice, viewers, sharers)
                };

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
                // Bytes since last refresh (5s tick interval) -> Mbps.
                let net_rx_mbps = (rx_bytes as f64 * 8.0) / 5.0 / 1_000_000.0;
                let net_tx_mbps = (tx_bytes as f64 * 8.0) / 5.0 / 1_000_000.0;

                let payload = format!(
                    r#"{{"status":"ok","public_url":"{}","node_id":"{}","region":"{}","voice_sessions":{},"video_viewers":{},"video_sharers":{},"cpu_pct":{:.1},"mem_pct":{:.1},"net_rx_mbps":{:.2},"net_tx_mbps":{:.2}}}"#,
                    public_url, node_id, region, voice_sessions, video_viewers, video_sharers,
                    cpu_pct, mem_pct, net_rx_mbps, net_tx_mbps
                );
                if let Err(e) = nats_clone.publish(
                    "media.heartbeat".to_string(), bytes::Bytes::from(payload),
                ).await {
                    error!("Heartbeat publish failed: {}", e);
                }
            }
        });
    }

    // ── 6. Accept connections ─────────────────────────────────────────────────
    loop {
        let incoming_session = server.accept().await;
        let secret           = jwt_secret.clone();
        let sessions         = sessions.clone();
        let move_senders     = move_senders.clone();
        let rooms            = rooms.clone();
        let nats_for_session = nats_client.clone();
        let tree_for_session = channel_tree.clone();

        tokio::spawn(async move {
            handle_connection(
                incoming_session, secret, sessions, rooms,
                move_senders, nats_for_session, tree_for_session,
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
) {
    let subject = "specter.cmd.>";
    let mut subscriber = match nats.subscribe(subject).await {
        Ok(s)  => s,
        Err(e) => { error!("Failed to subscribe to NATS commands: {}", e); return; }
    };

    // Also subscribe to event tree updates
    let event_subject = "specter.event.tree.>";
    let mut event_subscriber = match nats.subscribe(event_subject).await {
        Ok(s)  => s,
        Err(e) => { error!("Failed to subscribe to event tree updates: {}", e); return; }
    };

    info!("Listening for NATS commands on '{}' and event trees on '{}'", subject, event_subject);

    loop {
        tokio::select! {
            Some(msg) = subscriber.next() => {
                let parts: Vec<&str> = msg.subject.split('.').collect();
                if parts.len() < 4 { continue; }

                match parts[2] {
            "kick" => {
                let target = parts[3];
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
            "drain_org" => {
                // Force-closes every session belonging to one org, without touching
                // other orgs sharing this node — used during a node migration so
                // draining is scoped to the org being moved, not the whole node
                // (a whole-node drain causes a synchronized mass-disconnect across
                // every unrelated org that happens to be hosted here). This bus is
                // unauthenticated unless NATS_AUTH_TOKEN is set (see note above on
                // "kick") — drain_org can silently empty an entire org's voice
                // channels, so it inherits that exposure and then some.
                let target_org = parts[3];
                info!("DRAIN_ORG command for org {}", target_org);
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
                info!("Drained {} session(s) for org {}", drained, target_org);
            }
            "mute" => {
                let target = parts[3];
                info!("MUTE command for {}", target);
                let mut rooms_lock = rooms.write().await;
                for state in rooms_lock.values_mut() {
                    if state.members.contains(target) {
                        state.user_gains.insert(target.to_string(), 0.0);
                        break;
                    }
                }
            }
            "unmute" => {
                let target = parts[3];
                info!("UNMUTE command for {}", target);
                let mut rooms_lock = rooms.write().await;
                for state in rooms_lock.values_mut() {
                    if state.members.contains(target) {
                        state.user_gains.insert(target.to_string(), 1.0);
                        break;
                    }
                }
            }
            "move" if parts.len() >= 5 => {
                let target      = parts[3];
                let new_channel = parts[4];
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
            other => {
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
    jwt_secret: Arc<String>,
    sessions: SessionRegistry,
    rooms: RoomRegistry,
    move_senders: MoveRegistry,
    nats: Option<async_nats::Client>,
    channel_tree: ChannelTreeRegistry,
) {
    let request = match incoming_session.await {
        Ok(req) => req,
        Err(e)  => { error!("Handshake failed: {}", e); return; }
    };

    let path = request.path().to_string();
    if path.starts_with("/specter/video") {
        handle_video_connection(request, jwt_secret, rooms, nats).await;
    } else {
        handle_voice_connection(request, jwt_secret, sessions, rooms, move_senders, nats, channel_tree).await;
    }
}

async fn handle_voice_connection(
    request: wtransport::endpoint::SessionRequest,
    jwt_secret: Arc<String>,
    sessions: SessionRegistry,
    rooms: RoomRegistry,
    move_senders: MoveRegistry,
    nats: Option<async_nats::Client>,
    channel_tree: ChannelTreeRegistry,
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

    // ── 2. Validate JWT ───────────────────────────────────────────────────────
    let key: Hmac<Sha256> = match Hmac::new_from_slice(jwt_secret.as_bytes()) {
        Ok(k)  => k,
        Err(_) => { error!("Invalid JWT secret"); return; }
    };
    let claims: BTreeMap<String, Value> = match token_str.as_str().verify_with_key(&key) {
        Ok(c)  => c,
        Err(e) => { warn!("Invalid JWT: {}", e); return; }
    };
    if is_token_expired(&claims) {
        warn!("Connection rejected: expired JWT");
        return;
    }

    let get_str = |k: &str| -> String {
        claims.get(k).and_then(|v| v.as_str()).unwrap_or_default().to_string()
    };
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

    // The server already authorized this token for a *specific* channel_id at
    // mint time (org membership, group-assignment lock, restricted-mode
    // command/frequency checks) — but without binding that decision into the
    // token itself, a token minted for channel A could be replayed here to
    // connect to a different channel B, since channel_id was otherwise taken
    // from the connection request at face value with no cross-check.
    let token_channel_id = get_str("channel_id");
    if token_channel_id != channel_id {
        warn!(
            "Connection rejected: token channel_id ({}) does not match requested channel_id ({})",
            token_channel_id, channel_id
        );
        return;
    }

    let is_priority = {
        // Priority tiers 1 and 2 (Commander / Squad Leader equivalent) cause ducking.
        // Falls back to the legacy Commander role check for tokens that pre-date the
        // priority_level claim (e.g. existing sessions during a rolling deploy).
        let level = claims.get("priority_level").and_then(|v| v.as_i64()).unwrap_or(5);
        let legacy = role == "Commander"
            && claims.get("is_priority_channel").and_then(|v| v.as_bool()).unwrap_or(false);
        level <= 2 || legacy
    };
    info!("JWT OK — user={}, org={}, channel={}, priority={}", user_id, org_id, channel_id, is_priority);

    // ── Billing counters ──────────────────────────────────────────────────────
    let session_start     = Instant::now();
    let bytes_out_counter = Arc::new(AtomicU64::new(0));

    if let Some(ref n) = nats {
        let p = format!(r#"{{"org_id":"{}","user_id":"{}","channel_id":"{}"}}"#, org_id, user_id, channel_id);
        let _ = n.publish("specter.usage.session_start", bytes::Bytes::from(p)).await;
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

    // Nonce assigned inside the rooms write-lock below; used later in cleanup.
    let mut join_nonce: usize = 0;
    // Captured outside the block below (which drops `is_new` at its closing
    // brace) so the retroactive leader dual-subscribe check after it can tell
    // whether this connection just created a brand-new room.
    let mut is_new_room = false;

    let (pcm_tx, uos_arc, _roster_tx_clone, roster_rx, video_ctrl_tx, video_ctrl_rx, _video_vc, video_sharers_arc, _video_headers_arc, _video_keyframes_arc, snapshot) = {
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
                priority_users:      HashSet::new(),
                priority_speaker:    None,
                priority_release_at: None,
                pcm_tx:              new_pcm_tx,
                user_output_senders: new_uos_clone,
                video_ctrl_tx:          new_video_ctrl_tx,
                video_streams:          Arc::new(RwLock::new(HashMap::new())),
                video_viewer_count:     Arc::new(AtomicU32::new(0)),
                video_sharers:          Arc::new(RwLock::new(HashMap::new())),
                video_headers:          Arc::new(RwLock::new(HashMap::new())),
                video_keyframes:        Arc::new(RwLock::new(HashMap::new())),
                video_overlay_streams:      Arc::new(RwLock::new(HashMap::new())),
                video_overlay_headers:      Arc::new(RwLock::new(HashMap::new())),
                video_overlay_keyframes:     Arc::new(RwLock::new(HashMap::new())),
                video_activation_senders:    Arc::new(RwLock::new(HashMap::new())),
                session_nonces:              HashMap::new(),
                video_publish_nonces:        Arc::new(RwLock::new(HashMap::new())),
                member_orgs:                 HashMap::new(),
            });
            spawn_mixer = Some((new_pcm_rx, new_uos));
        }

        let state = room_registry.get_mut(&channel_id).unwrap();
        state.members.insert(user_id.clone());
        state.callsigns.insert(user_id.clone(), callsign.clone());
        state.user_gains.insert(user_id.clone(), 1.0);
        state.user_audio_thresholds.insert(user_id.clone(), 150.0);
        state.member_orgs.insert(user_id.clone(), org_id.clone());
        if is_priority { state.priority_users.insert(user_id.clone()); }

        // Record a unique nonce for this join so that cleanup can detect
        // whether a newer session has already re-claimed this user's slot.
        join_nonce = SESSION_NONCE.fetch_add(1, Ordering::Relaxed);
        state.session_nonces.insert(user_id.clone(), join_nonce);

        let snap: Vec<String> = state.members.iter()
            .map(|uid| state.callsigns.get(uid).cloned().unwrap_or_else(|| uid.clone()))
            .collect();
        let join = serde_json::to_string(&RosterMessage::Join(callsign.clone())).unwrap();
        let _ = state.roster_tx.send(join);

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
        )
    };

    // Spawn mixer after lock release to avoid deadlocks.
    if let Some((pcm_rx, uos)) = spawn_mixer {
        tokio::spawn(mixer_task(channel_id.clone(), rooms.clone(), pcm_rx, uos, nats.clone(), channel_tree.clone()));
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
    if is_new_room {
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
    {
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
    let was_killed = if roster_write_ok {
        run_session_loop(
            session, kill_rx, move_rx, user_id.clone(), callsign.clone(),
            pcm_tx, out_rx, roster_stream, roster_rx,
            bytes_out_counter.clone(),
            video_ctrl_rx, video_ctrl_tx,
            rooms.clone(), channel_id.clone(),
        ).await
    } else {
        warn!("Session {} aborting before entering session loop — initial roster snapshot failed to send", user_id);
        false
    };

    // ── 8. Cleanup ────────────────────────────────────────────────────────────
    // When killed by a duplicate session, the NEW session has already registered
    // its own entries in sessions/move_senders/room state. Removing here would
    // orphan the new session (mixer can't send audio, roster shows Leave, etc.).
    if !was_killed {
        { sessions.write().await.remove(&session_key); }
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
                    state.priority_users.remove(&user_id);
                    state.member_orgs.remove(&user_id);

                    if state.priority_speaker.as_deref() == Some(user_id.as_str()) {
                        state.priority_speaker    = None;
                        state.priority_release_at = None;
                    }

                    let leave = serde_json::to_string(&RosterMessage::Leave(display_name)).unwrap();
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
        let p = format!(
            r#"{{"org_id":"{}","user_id":"{}","channel_id":"{}","duration_secs":{},"bytes_out":{},"superseded":{}}}"#,
            org_id, user_id, channel_id, dur, bytes, was_killed
        );
        let _ = n.publish("specter.usage.session_end", bytes::Bytes::from(p)).await;
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

    loop {
        tokio::select! {
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
                            if payload[1] == 0x01 && payload.len() >= 4 {
                                let mut sig = vec![0xFF, 0x01, payload[2]];
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
                        debug!("{} audio datagram: {} bytes", user_id, payload.len());
                        match proto::specter::v1::AudioFrame::decode(payload.as_ref()) {
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
    jwt_secret: Arc<String>,
    rooms: RoomRegistry,
    nats: Option<async_nats::Client>,
) {
    let path = request.path().to_string();
    let mut token = String::new();
    let mut channel_id = String::new();
    let mut role = String::new();
    let mut sharer = String::new();

    if let Some(pos) = path.find('?') {
        for pair in path[pos + 1..].split('&') {
            let mut kv = pair.splitn(2, '=');
            match (kv.next(), kv.next()) {
                (Some("token"), Some(v)) => token = v.to_string(),
                (Some("channel_id"), Some(v)) => channel_id = v.to_string(),
                (Some("role"), Some(v)) => role = v.to_string(),
                (Some("sharer"), Some(v)) => sharer = urlencoding::decode(v).unwrap_or(std::borrow::Cow::Borrowed(v)).to_string(),
                _ => {}
            }
        }
    }

    if token.is_empty() || channel_id.is_empty() || role.is_empty() {
        warn!("Video connection rejected: missing params");
        return;
    }

    let key: Hmac<Sha256> = match Hmac::new_from_slice(jwt_secret.as_bytes()) {
        Ok(k) => k,
        Err(_) => { error!("Invalid JWT secret"); return; }
    };
    let claims: BTreeMap<String, Value> = match token.as_str().verify_with_key(&key) {
        Ok(c) => c,
        Err(e) => { warn!("Invalid JWT: {}", e); return; }
    };
    if is_token_expired(&claims) {
        warn!("Video connection rejected: expired JWT");
        return;
    }

    let user_id = claims.get("sub").or_else(|| claims.get("user_id")).and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let callsign = claims.get("callsign").and_then(|v| v.as_str()).unwrap_or(&user_id).to_string();
    let org_id = claims.get("org_id").and_then(|v| v.as_str()).unwrap_or_default().to_string();

    if user_id.is_empty() {
        warn!("Video connection rejected: missing user_id");
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

    if role == "publish" {
        handle_video_publish(session, user_id, callsign, channel_id, rooms).await;
    } else if role == "subscribe" {
        handle_video_subscribe(session, user_id, callsign.clone(), sharer, channel_id, org_id, rooms, nats).await;
    } else if role == "subscribe_overlay" {
        handle_video_overlay_subscribe(session, user_id, callsign.clone(), sharer, channel_id, org_id, rooms, nats).await;
    } else {
        warn!("Video connection rejected: unknown role {}", role);
    }
}

async fn handle_video_publish(
    session: wtransport::Connection,
    user_id: String,
    callsign: String,
    channel_id: String,
    rooms: RoomRegistry,
) {
    let session = std::sync::Arc::new(session);
    info!("Video publish: '{}' ({}) starting share in channel '{}'", callsign, user_id, channel_id);
    let (video_ctrl_tx, video_streams, video_sharers, video_headers, video_keyframes,
         video_overlay_streams, video_overlay_headers, video_overlay_keyframes,
         video_activation_senders, video_publish_nonces) = {
        let rooms_read = rooms.read().await;
        if let Some(room) = rooms_read.get(&channel_id) {
            (
                room.video_ctrl_tx.clone(),
                room.video_streams.clone(),
                room.video_sharers.clone(),
                room.video_headers.clone(),
                room.video_keyframes.clone(),
                room.video_overlay_streams.clone(),
                room.video_overlay_headers.clone(),
                room.video_overlay_keyframes.clone(),
                room.video_activation_senders.clone(),
                room.video_publish_nonces.clone(),
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

    // Create a per-sharer activation watch channel (starts at 0 viewers = inactive).
    // Must be inserted BEFORE video_headers/video_sharers so any concurrent
    // handle_video_subscribe always finds the sender when the sharer is visible.
    let (act_tx, act_rx) = watch::channel::<u32>(0);
    video_activation_senders.write().await.insert(user_id.clone(), act_tx);

    // Spawn task that signals the publisher client to activate/deactivate streaming
    // based on viewer count transitions (0→1 = activate, last→0 = deactivate).
    let session_for_act = Arc::clone(&session);
    let act_task = tokio::spawn(async move {
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
            }
            return;
        }
        Err(_) => {
            warn!("Video publish: timed out waiting for header stream from '{}'", callsign);
            act_task.abort();
            let mut nonces = video_publish_nonces.write().await;
            if nonces.get(&user_id).copied() == Some(publish_nonce) {
                nonces.remove(&user_id);
                drop(nonces);
                video_activation_senders.write().await.remove(&user_id);
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
                video_streams.write().await.insert(user_id.clone(), my_video_tx.clone());
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

                // Spawn a task to accept and relay the overlay stream (0x03 type prefix)
                let overlay_task = {
                    let session2 = std::sync::Arc::clone(&session);
                    let uid2 = user_id.clone();
                    let ov_streams = video_overlay_streams.clone();
                    let ov_headers = video_overlay_headers.clone();
                    let ov_keyframes = video_overlay_keyframes.clone();
                    tokio::spawn(async move {
                        // Own per-sharer overlay channel — same rationale as my_video_tx above.
                        let (ovtx, _) = broadcast::channel::<(bytes::Bytes, Instant)>(512);
                        // Wait for the overlay uni stream (client opens it shortly after the main stream)
                        let mut ov_stream = match tokio::time::timeout(
                            std::time::Duration::from_secs(5),
                            session2.accept_uni()
                        ).await {
                            Ok(Ok(s)) => s,
                            _ => return, // no overlay stream — client may not support simulcast
                        };

                        // Read and validate the 0x03 type prefix
                        let mut type_byte = [0u8; 1];
                        if tokio::io::AsyncReadExt::read_exact(&mut ov_stream, &mut type_byte).await.is_err()
                            || type_byte[0] != 0x03 {
                            return;
                        }

                        // Read overlay header
                        let mut hlen_buf = [0u8; 4];
                        if tokio::io::AsyncReadExt::read_exact(&mut ov_stream, &mut hlen_buf).await.is_err() {
                            return;
                        }
                        let header_len = u32::from_be_bytes(hlen_buf) as usize;
                        if header_len > MAX_VIDEO_HEADER_LEN {
                            warn!("Overlay publish: header_len {} from '{}' exceeds {}-byte cap", header_len, uid2, MAX_VIDEO_HEADER_LEN);
                            return;
                        }
                        let mut header_bytes = vec![0u8; header_len];
                        if tokio::io::AsyncReadExt::read_exact(&mut ov_stream, &mut header_bytes).await.is_err() {
                            return;
                        }
                        let mut header_blob = Vec::with_capacity(4 + header_len);
                        header_blob.extend_from_slice(&hlen_buf);
                        header_blob.extend_from_slice(&header_bytes);
                        ov_headers.write().await.insert(uid2.clone(), header_blob);
                        ov_streams.write().await.insert(uid2.clone(), ovtx.clone());

                        info!("Overlay stream started for '{}'", uid2);

                        // Relay overlay frames
                        loop {
                            let mut size_buf = [0u8; 4];
                            match tokio::io::AsyncReadExt::read_exact(&mut ov_stream, &mut size_buf).await {
                                Ok(_) => {}
                                Err(_) => break,
                            }
                            let frame_size = u32::from_be_bytes(size_buf) as usize;
                            if frame_size == 0 || frame_size > 10_000_000 { break; }

                            let mut frame_body = vec![0u8; frame_size];
                            match tokio::io::AsyncReadExt::read_exact(&mut ov_stream, &mut frame_body).await {
                                Ok(_) => {}
                                Err(_) => break,
                            }

                            let mut framed = Vec::with_capacity(4 + frame_size);
                            framed.extend_from_slice(&size_buf);
                            framed.extend_from_slice(&frame_body);
                            let framed_bytes = bytes::Bytes::from(framed);

                            if frame_body.first() == Some(&0x00) {
                                ov_keyframes.write().await.insert(uid2.clone(), framed_bytes[..].to_vec());
                            }

                            let _ = ovtx.send((framed_bytes, Instant::now()));
                        }

                        ov_headers.write().await.remove(&uid2);
                        ov_keyframes.write().await.remove(&uid2);
                        ov_streams.write().await.remove(&uid2);
                        info!("Overlay stream ended for '{}'", uid2);
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

                    // Update keyframe cache if this is an IDR (type byte == 0x00)
                    if frame_body.first() == Some(&0x00) {
                        video_keyframes.write().await.insert(user_id.clone(), framed_bytes[..].to_vec());
                    }

                    // Broadcast exactly one complete frame
                    let _ = my_video_tx.send((framed_bytes, Instant::now()));
                }
                // Main relay loop exited — abort the overlay and activation tasks to
                // prevent them writing into a dismantled RoomState after disconnect.
                overlay_task.abort();
                act_task.abort();
            }
            }
        }
    }

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
    video_overlay_headers.write().await.remove(&user_id);
    video_overlay_keyframes.write().await.remove(&user_id);
    video_activation_senders.write().await.remove(&user_id);
    // Empty-chunk sentinel tells any subscriber still holding a receiver on this
    // sharer's channel to break its loop cleanly, before the channel itself is
    // torn down by removing it from video_streams (dropping the last Sender causes
    // outstanding Receivers to see Closed instead, which subscribers also handle,
    // but this gives them the same clean empty-chunk exit path as before).
    let _ = my_video_tx.send((bytes::Bytes::new(), Instant::now()));
    video_streams.write().await.remove(&user_id);
    video_sharers.write().await.remove(&user_id);

    let mut sig = vec![0xFF, 0x01, 0];
    sig.extend_from_slice(callsign.as_bytes());
    let _ = video_ctrl_tx.send(bytes::Bytes::from(sig));
}

async fn handle_video_overlay_subscribe(
    session: wtransport::Connection,
    subscriber_user_id: String,
    subscriber_callsign: String,
    sharer_callsign: String,
    channel_id: String,
    org_id: String,
    rooms: RoomRegistry,
    nats: Option<async_nats::Client>,
) {
    info!("Overlay subscribe: '{}' wants overlay of '{}' in channel '{}'",
        subscriber_callsign, sharer_callsign, channel_id);

    // Billing meters egress — what the server actually serves to this viewer —
    // not the sharer's single upload, since N viewers of the same stream cost
    // the server N× the bytes. Published once the subscribe session ends.
    let session_start = std::time::Instant::now();
    let mut bytes_sent: u64 = 0;

    let (video_overlay_streams, sharer_uid, video_overlay_headers, video_overlay_keyframes) = {
        let rooms_read = rooms.read().await;
        if let Some(room) = rooms_read.get(&channel_id) {
            let sharers = room.video_sharers.read().await;
            let uid = sharers.iter()
                .find(|(_, cs)| cs.as_str() == sharer_callsign.as_str())
                .map(|(k, _)| k.clone());
            if let Some(uid) = uid {
                (room.video_overlay_streams.clone(), uid, room.video_overlay_headers.clone(), room.video_overlay_keyframes.clone())
            } else {
                warn!("Overlay subscribe: sharer '{}' not found in room '{}'", sharer_callsign, channel_id);
                return;
            }
        } else {
            warn!("Overlay subscribe: channel '{}' has no room", channel_id);
            return;
        }
    };

    // The sharer's overlay channel is registered slightly after the main video
    // channel (its accept_uni() for the overlay stream happens in a spawned task),
    // so it may not exist yet even though the sharer itself is already visible.
    let overlay_tx = match video_overlay_streams.read().await.get(&sharer_uid).cloned() {
        Some(tx) => tx,
        None => {
            warn!("Overlay subscribe: '{}' has no active overlay stream yet", sharer_callsign);
            return;
        }
    };
    let mut video_rx = overlay_tx.subscribe();

    let header_opt = video_overlay_headers.read().await.get(&sharer_uid).cloned();
    let keyframe_opt = video_overlay_keyframes.read().await.get(&sharer_uid).cloned();

    let opening = match session.open_uni().await {
        Ok(o) => o,
        Err(e) => { warn!("Overlay subscribe: open_uni() failed for '{}': {}", subscriber_callsign, e); return; }
    };
    let mut stream = match opening.await {
        Ok(s) => s,
        Err(e) => { warn!("Overlay subscribe: opening.await failed for '{}': {}", subscriber_callsign, e); return; }
    };

    // Use 0x03 prefix for overlay stream
    let mut prefix: Vec<u8> = vec![0x03];
    if let Some(ref h) = header_opt { prefix.extend_from_slice(h); }
    if let Some(ref kf) = keyframe_opt { prefix.extend_from_slice(kf); }

    if stream.write_all(&prefix).await.is_ok() {
        bytes_sent += prefix.len() as u64;
        let mut needs_resync = false;
        loop {
            tokio::select! {
                vdata = video_rx.recv() => {
                    match vdata {
                        Ok((chunk, produced_at)) => {
                            if chunk.is_empty() { break; }
                            let is_keyframe = chunk.len() > 4 && chunk[4] == 0x00;
                            if needs_resync {
                                if !is_keyframe { continue; }
                                needs_resync = false;
                            } else if !is_keyframe && produced_at.elapsed() > MAX_VIDEO_FRAME_AGE {
                                needs_resync = true;
                                continue;
                            }
                            if stream.write_all(&chunk).await.is_err() { break; }
                            bytes_sent += chunk.len() as u64;
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            warn!("Overlay subscribe: '{}' lagged {} frames — seeking keyframe", subscriber_callsign, n);
                            needs_resync = true;
                        }
                        Err(_) => break,
                    }
                }
                _ = session.closed() => { break; }
            }
        }
    }

    if let Some(ref n) = nats {
        if !org_id.is_empty() {
            let dur = session_start.elapsed().as_secs();
            let p = format!(
                r#"{{"org_id":"{}","user_id":"{}","channel_id":"{}","duration_secs":{},"bytes_out":{}}}"#,
                org_id, subscriber_user_id, channel_id, dur, bytes_sent
            );
            let _ = n.publish("specter.usage.session_end", bytes::Bytes::from(p)).await;
        }
    }
}

async fn handle_video_subscribe(
    session: wtransport::Connection,
    subscriber_user_id: String,
     subscriber_callsign: String,
    sharer_callsign: String,
    channel_id: String,
    org_id: String,
    rooms: RoomRegistry,
    nats: Option<async_nats::Client>,
) {
    info!("Video subscribe: '{}' wants to watch '{}' in channel '{}'",
        subscriber_callsign, sharer_callsign, channel_id);
    // Billing meters egress — what the server actually serves to this viewer —
    // not the sharer's single upload, since N viewers of the same stream cost
    // the server N× the bytes. Published once the subscribe session ends.
    let session_start = std::time::Instant::now();
    let mut bytes_sent: u64 = 0;
    let (video_streams, video_ctrl_tx, sharer_uid, video_viewer_count, video_headers, video_keyframes, video_activation_senders) = {
        let rooms_read = rooms.read().await;
        if let Some(room) = rooms_read.get(&channel_id) {
            let sharers = room.video_sharers.read().await;
            let uid = sharers.iter().find(|(_, cs)| cs.as_str() == sharer_callsign.as_str()).map(|(k, _)| k.clone());
            if let Some(uid) = uid {
                info!("Video subscribe: sharer '{}' ({}) found — forwarding stream to '{}'",
                    sharer_callsign, uid, subscriber_callsign);
                (room.video_streams.clone(), room.video_ctrl_tx.clone(), uid, room.video_viewer_count.clone(), room.video_headers.clone(), room.video_keyframes.clone(), room.video_activation_senders.clone())
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
    let mut video_rx = sharer_tx.subscribe();

    let header_opt = video_headers.read().await.get(&sharer_uid).cloned();
    let keyframe_opt = video_keyframes.read().await.get(&sharer_uid).cloned();
    info!("Video subscribe: header={}, keyframe={} for subscriber '{}'",
        if header_opt.is_some() { "yes" } else { "MISSING" },
        if keyframe_opt.is_some() { "yes" } else { "MISSING" },
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
    if let Some(ref kf) = keyframe_opt { prefix.extend_from_slice(kf); }

    if stream.write_all(&prefix).await.is_ok() {
        bytes_sent += prefix.len() as u64;
        info!("Video subscribe: prefix written ({} bytes), entering frame loop for '{}'", prefix.len(), subscriber_callsign);
        let mut frames_sent: u64 = 0;
        // Set on a Lagged overflow or a stale delta frame; cleared once a keyframe
        // arrives. While set, every non-keyframe chunk is dropped rather than
        // written, since a P-frame relayed after a gap would reference frames the
        // decoder never saw and corrupt decode until the next keyframe anyway.
        let mut needs_resync = false;
        loop {
            tokio::select! {
                vdata = video_rx.recv() => {
                    match vdata {
                        Ok((chunk, produced_at)) => {
                            if chunk.is_empty() { break; }
                            // Keyframe: type byte is at offset 4 (after 4-byte size header)
                            let is_keyframe = chunk.len() > 4 && chunk[4] == 0x00;
                            if needs_resync {
                                if !is_keyframe { continue; }
                                needs_resync = false;
                            } else if !is_keyframe && produced_at.elapsed() > MAX_VIDEO_FRAME_AGE {
                                // Already too stale to bother writing — a slow write here would
                                // only let us fall further behind. Drop it (and the rest of this
                                // GOP) instead of waiting for the broadcast channel to overflow.
                                needs_resync = true;
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
                            needs_resync = true;
                        }
                        Err(_) => break,
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
            let p = format!(
                r#"{{"org_id":"{}","user_id":"{}","channel_id":"{}","duration_secs":{},"bytes_out":{}}}"#,
                org_id, subscriber_user_id, channel_id, dur, bytes_sent
            );
            let _ = n.publish("specter.usage.session_end", bytes::Bytes::from(p)).await;
        }
    }
}
