const COMMANDS: &[&str] = &[
    "list_audio_devices",
    "list_output_devices",
    "start_capture",
    "stop_capture",
    "play_frame",
    "set_output_device",
    // Without an ACL entry Tauri rejects the invoke ("not allowed by ACL"):
    // set_send_threshold was registered but never listed here, so every
    // client call failed silently and the native gate stayed at its 150
    // default whatever the user's threshold was.
    "set_send_threshold",
    "set_vad_config",
    // Same silent ACL rejection: clear_stream frees a relay speaker's
    // playback lane (voiceRelayAudio / useMonitorChannel lane cleanup) and
    // get_audio_pipeline_log feeds diagnostics.
    "clear_stream",
    "get_audio_pipeline_log",
    // Per-voice-stream listener volume ("this user's voice, for me").
    "set_stream_volume",
    // Screen-share audio (STREAMING_PLAN S1-S3).
    "share_audio_start",
    "share_audio_stop",
    "share_audio_play_frame",
    "share_audio_set_volume",
    "share_audio_set_delay",
    "share_audio_playback_stop",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
