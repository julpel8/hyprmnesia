// hpm-wlcap — Linux/Wayland screen capture helper.

mod linux;

fn main() -> anyhow::Result<()> {
    linux::run()
}
