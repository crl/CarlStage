use std::{io::Write, net::{TcpListener, TcpStream}, process::{Child, Command, Stdio}, sync::Mutex, thread, time::Duration};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

struct Backend(Mutex<Option<(Child, u16)>>);

fn stop_backend(child: &mut Child, port: u16) {
    if let Ok(mut stream) = TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_secs(1)) {
        let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
        let _ = stream.write_all(b"POST /api/shutdown HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
    for _ in 0..60 {
        if matches!(child.try_wait(), Ok(Some(_))) { return; }
        thread::sleep(Duration::from_millis(100));
    }
    #[cfg(windows)] {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("taskkill").args(["/PID", &child.id().to_string(), "/T", "/F"]).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let url = if cfg!(debug_assertions) {
                "http://127.0.0.1:5173".to_string()
            } else {
                let listener = TcpListener::bind("127.0.0.1:0")?;
                let port = listener.local_addr()?.port();
                drop(listener);
                let runtime = app.path().resource_dir()?.join("runtime");
                let node = runtime.join(if cfg!(windows) { "node.exe" } else { "node" });
                let data = app.path().app_data_dir()?;
                std::fs::create_dir_all(&data)?;
                let mut child = Command::new(node)
                    .arg("server/index.mjs")
                    .current_dir(&runtime)
                    .env("REELBENCH_DATA_DIR", data)
                    .env("REELBENCH_PORT", port.to_string())
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .spawn()?;
                let mut ready = false;
                for _ in 0..100 {
                    if child.try_wait()?.is_some() { return Err("本机服务提前退出".into()); }
                    if TcpStream::connect(format!("127.0.0.1:{port}")).is_ok() {
                        ready = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                if !ready {
                    stop_backend(&mut child, port);
                    return Err("本机服务启动失败".into());
                }
                app.manage(Backend(Mutex::new(Some((child, port)))));
                format!("http://127.0.0.1:{port}")
            };
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse()?))
                .title("CarlStage")
                .inner_size(1280.0, 800.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(backend) = window.app_handle().try_state::<Backend>() {
                    if let Ok(mut child) = backend.0.lock() {
                        if let Some((mut child, port)) = child.take() { stop_backend(&mut child, port); }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动 CarlStage");
}
