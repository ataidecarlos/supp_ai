use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::thread::JoinHandle;
use std::time::Duration;

use serde_json::{Value, json};

use super::error::{Error, Result};

type Responder = mpsc::Sender<Result<Value>>;

fn id_key(id: &Value) -> Option<String> {
    match id {
        Value::Number(number) => Some(number.to_string()),
        Value::String(text) => Some(text.clone()),
        _ => None,
    }
}
type NotificationHandler = Box<dyn Fn(Value) + Send>;
type PermissionHandler = Box<dyn Fn(Value) -> Value + Send>;

pub struct AcpClient {
    child: Mutex<Option<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Arc<Mutex<HashMap<String, Responder>>>,
    next_id: AtomicU64,
    closed: Arc<AtomicBool>,
    reader: Mutex<Option<JoinHandle<()>>>,
    notification: Arc<Mutex<Option<NotificationHandler>>>,
    permission: Arc<Mutex<Option<PermissionHandler>>>,
}

impl AcpClient {
    pub fn spawn(
        command: &str,
        args: &[&str],
        cwd: &Path,
        home: &Path,
        extra_env: &[(&str, &str)],
    ) -> Result<Self> {
        std::fs::create_dir_all(home)
            .map_err(|error| Error::new("CLI", format!("Cannot create {}: {error}", home.display())))?;
        let mut process = Command::new(command);
        process
            .args(args)
            .current_dir(cwd)
            .env("COPILOT_HOME", home)
            .env("COPILOT_ALLOW_ALL", "false")
            .env("COPILOT_AUTO_UPDATE", "false")
            .env_remove("COPILOT_CUSTOM_INSTRUCTIONS_DIRS")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        for (key, value) in extra_env {
            process.env(key, value);
        }
        let mut child = process.spawn().map_err(|error| {
            Error::new(
                "CLI",
                format!("Cannot start GitHub Copilot CLI: {error}. Install it and run copilot login."),
            )
        })?;
        let stdout = child.stdout.take().ok_or_else(|| Error::new("CLI", "No stdout from the CLI."))?;
        let stderr = child.stderr.take();
        let stdin = child.stdin.take().ok_or_else(|| Error::new("CLI", "No stdin to the CLI."))?;
        let pending: Arc<Mutex<HashMap<String, Responder>>> = Arc::new(Mutex::new(HashMap::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let notification: Arc<Mutex<Option<NotificationHandler>>> = Arc::new(Mutex::new(None));
        let permission: Arc<Mutex<Option<PermissionHandler>>> = Arc::new(Mutex::new(None));
        let stdin = Arc::new(Mutex::new(stdin));

        if let Some(stderr) = stderr {
            std::thread::spawn(move || {
                let mut buffer = String::new();
                for line in BufReader::new(stderr).lines().map_while(std::result::Result::ok) {
                    buffer.push_str(&line);
                    buffer.push('\n');
                    if buffer.len() > 8_000 {
                        buffer = buffer.split_off(buffer.len() - 4_000);
                    }
                }
            });
        }

        let reader_pending = pending.clone();
        let reader_closed = closed.clone();
        let reader_stdin = stdin.clone();
        let reader_notification = notification.clone();
        let reader_permission = permission.clone();
        let reader = std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let Ok(line) = line else { break };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
                let id = message.get("id").cloned().filter(|id| !id.is_null());
                let id = id.as_ref().and_then(id_key);
                let method = message.get("method").and_then(Value::as_str);
                match (id, method) {
                    (Some(id), Some(method)) => {
                        let decision = request_response(method, &message, &reader_permission);
                        let response = json!({ "jsonrpc": "2.0", "id": id, "result": decision });
                        write_message(&reader_stdin, &response);
                    }
                    (Some(id), None) => {
                        let responder = reader_pending.lock().unwrap().remove(&id);
                        if let Some(responder) = responder {
                            let outcome = match message.get("error") {
                                Some(error) => Err(Error::new(
                                    "ACP",
                                    error
                                        .get("message")
                                        .and_then(Value::as_str)
                                        .unwrap_or("The agent rejected the request.")
                                        .to_string(),
                                )),
                                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = responder.send(outcome);
                        }
                    }
                    (None, Some(_)) => {
                        if let Some(handler) = reader_notification.lock().unwrap().as_ref() {
                            handler(message);
                        }
                    }
                    (None, None) => {}
                }
            }
            reader_closed.store(true, Ordering::SeqCst);
            let mut waiting = reader_pending.lock().unwrap();
            for (_, responder) in waiting.drain() {
                let _ = responder.send(Err(Error::new("CLI", "Copilot CLI exited while a request was pending.")));
            }
        });

        Ok(AcpClient {
            child: Mutex::new(Some(child)),
            stdin,
            pending,
            next_id: AtomicU64::new(1),
            closed,
            reader: Mutex::new(Some(reader)),
            notification,
            permission,
        })
    }

    pub fn on_notification(&self, handler: NotificationHandler) {
        *self.notification.lock().unwrap() = Some(handler);
    }

    pub fn on_permission(&self, handler: PermissionHandler) {
        *self.permission.lock().unwrap() = Some(handler);
    }

    pub fn notify(&self, method: &str, params: Value) -> Result<()> {
        let message = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        write_message(&self.stdin, &message);
        Ok(())
    }

    pub fn request(&self, method: &str, params: Value) -> Result<Value> {
        self.request_timeout(method, params, Duration::from_secs(60))
    }

    pub fn request_timeout(&self, method: &str, params: Value, timeout: Duration) -> Result<Value> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(Error::new("CLI", "Copilot CLI is not running."));
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (sender, receiver) = mpsc::channel();
        self.pending.lock().unwrap().insert(id.to_string(), sender);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        write_message(&self.stdin, &message);
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(_) => {
                self.pending.lock().unwrap().remove(&id.to_string());
                Err(Error::new("TIMEOUT", format!("Copilot did not answer {method} in time.")))
            }
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(reader) = self.reader.lock().unwrap().take() {
            let _ = reader.join();
        }
    }
}

impl Drop for AcpClient {
    fn drop(&mut self) {
        self.close();
    }
}

fn request_response(
    method: &str,
    message: &Value,
    permission: &Mutex<Option<PermissionHandler>>,
) -> Value {
    if method == "session/request_permission" {
        if let Some(handler) = permission.lock().unwrap().as_ref() {
            return handler(message.clone());
        }
        return json!({ "outcome": { "outcome": "cancelled" } });
    }
    json!({})
}

fn write_message(stdin: &Mutex<ChildStdin>, message: &Value) {
    let Ok(mut stdin) = stdin.lock() else { return };
    if let Ok(line) = serde_json::to_string(message) {
        let _ = stdin.write_all(line.as_bytes());
        let _ = stdin.write_all(b"\n");
        let _ = stdin.flush();
    }
}
