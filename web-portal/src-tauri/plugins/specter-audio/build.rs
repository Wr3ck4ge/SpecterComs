const COMMANDS: &[&str] = &[
    "list_audio_devices",
    "list_output_devices",
    "start_capture",
    "stop_capture",
    "play_frame",
    "set_output_device",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
