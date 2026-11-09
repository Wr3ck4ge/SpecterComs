// Backpressure-aware sender for a video NAL relay stream: at most one write in
// flight and at most one frame queued behind it (always the freshest). Without
// this, each NAL event handler independently awaits its own writer.write() call
// with no coordination — under a congested/slow QUIC stream, writes pile up
// unboundedly (the WHATWG streams spec queues them internally with no bound),
// so latency only grows and the video keeps "buffering" further behind live.
// A dropped delta frame breaks the GOP's P-frame reference chain, so once one
// is dropped every subsequent delta is dropped too (needsResync) until the next
// keyframe — mirroring the identical resync pattern already used by the
// receiver (processVideoData) and by media-rust's subscriber relay loops.
// `onDrop`, if given, fires once per delta frame dropped due to backpressure —
// used as the congestion signal for real-time bitrate adaptation (see
// CommLink's startScreenShare). Optional.
// `onResync`, if given, fires once each time the pump starts dropping a GOP
// (needsResync false → true) — the sender asks its own encoder for a keyframe
// then (throttled; see PUBLISHER_CONGESTION_FORCE_INTERVAL_MS) instead of
// making every viewer sit on a frozen picture until the scheduled one.
// (Moved out of CommLink.jsx unchanged apart from onResync, so it can be
// unit-tested without loading the component.)
//
// Share audio (engine/shareAudio.js) normally goes as datagrams and never
// touches this pump. It comes here only on the in-stream fallback (a server
// that predates share-audio datagrams, or a packet too big for the path's
// datagram size), multiplexed into the same stream: `submit.audio(frameBuf)`.
// Priorities on that path:
//   - audio is written before any pending video frame (users notice an audio
//     gap far more than a dropped frame), so under backpressure video drops
//     first;
//   - audio has its own small queue (AUDIO_QUEUE_MAX frames, oldest dropped
//     on overflow) and its drops never call onDrop / onResync — they are not
//     a video-congestion signal and must not force keyframes;
//   - an audio write in flight does not count as "busy" for video: a delta
//     arriving then is queued (sent right after the audio), not dropped, so
//     the ~50 audio writes a second don't masquerade as congestion.
export const AUDIO_QUEUE_MAX = 10; // 200 ms of 20 ms Opus frames

export function createVideoSendPump(writerRef, onDrop, onResync) {
  let queued = null;      // the one pending video frame
  let videoInFlight = false;
  let sending = false;    // the pump loop is running
  let needsResync = false;
  const audioQueue = [];
  const startResync = () => {
    if (needsResync) return;
    needsResync = true;
    onResync?.();
  };

  const pump = async () => {
    if (sending) return;
    sending = true;
    try {
      while (audioQueue.length || queued) {
        if (audioQueue.length) {
          const audioBuf = audioQueue.shift();
          try { await writerRef.current.write(audioBuf); } catch { break; }
          continue;
        }
        const frameBuf = queued;
        queued = null;
        videoInFlight = true;
        try { await writerRef.current.write(frameBuf); } catch { break; } finally { videoInFlight = false; }
      }
    } finally {
      sending = false;
    }
  };

  function submit(frameBuf, isKeyframe) {
    if (videoInFlight || queued) {
      if (!isKeyframe) { startResync(); onDrop?.(); return; }
      queued = frameBuf; // keyframe always wins — becomes the sole pending item
      needsResync = false;
    } else {
      if (needsResync) {
        if (!isKeyframe) { onDrop?.(); return; }
        needsResync = false;
      }
      queued = frameBuf;
    }
    pump();
  }

  /** One share-audio frame (already framed + encrypted). Never blocks video. */
  submit.audio = (frameBuf) => {
    audioQueue.push(frameBuf);
    if (audioQueue.length > AUDIO_QUEUE_MAX) audioQueue.shift();
    pump();
  };

  return submit;
}
