//! Explicit native selection creates immutable, session-owned attachment snapshots.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const MAX_FILE: usize = 8 * 1024 * 1024;
const MAX_INPUT: usize = 16 * 1024 * 1024;
const MAX_TOTAL: usize = 24 * 1024 * 1024;
use base64::Engine;
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Attachment {
    version: u8,
    id: String,
    session_id: String,
    pub name: String,
    pub mime: String,
    bytes: usize,
    sha256: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    preview_url: Option<String>,
}
fn ordinary(path: &Path) -> Result<(), String> {
    for p in path.ancestors() {
        let m = fs::symlink_metadata(p).map_err(|_| "Attachment path is unavailable")?;
        if m.file_type().is_symlink() {
            return Err("Symbolic links are not supported for attachments".into());
        }
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if m.file_attributes() & 0x400 != 0 {
                return Err("Linked folders are not supported for attachments".into());
            }
        }
    }
    Ok(())
}
fn mime(data: &[u8]) -> Option<&'static str> {
    if data.len() >= 24
        && data.starts_with(&[137, 80, 78, 71, 13, 10, 26, 10])
        && &data[12..16] == b"IHDR"
    {
        let w = u32::from_be_bytes(data[16..20].try_into().ok()?);
        let h = u32::from_be_bytes(data[20..24].try_into().ok()?);
        return (w > 0
            && h > 0
            && w <= 8192
            && h <= 8192
            && u64::from(w) * u64::from(h) <= 20_000_000)
            .then_some("image/png");
    }
    if data.len() >= 4 && data.starts_with(&[255, 216, 255]) && data.ends_with(&[255, 217]) {
        return Some("image/jpeg");
    }
    if data.len() >= 12 && &data[..4] == b"RIFF" && &data[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if data.len() <= 128 * 1024
        && std::str::from_utf8(data).is_ok()
        && !data.iter().any(|b| *b < 32 && !matches!(b, 9 | 10 | 13))
    {
        return Some("text/plain");
    }
    None
}
fn capture(root: &Path, session: &str, paths: &[PathBuf]) -> Result<Vec<Attachment>, String> {
    let mut inputs=Vec::new();
    if paths.is_empty() || paths.len()>4 { return Err("Select one to four files".into()); }
    for path in paths { ordinary(path)?;
        let meta=fs::metadata(path).map_err(|_|"Cannot read the selected file")?;
        if !meta.is_file() || meta.len()==0 || meta.len()>MAX_INPUT as u64 {return Err("Each source file must be nonempty and at most 16 MiB".into());}
        let mut opts=OpenOptions::new();opts.read(true);
        #[cfg(windows)] {use std::os::windows::fs::OpenOptionsExt;opts.custom_flags(0x00200000);}
        let mut data=Vec::new();opts.open(path).map_err(|_|"Cannot open selected file")?.take((MAX_INPUT+1) as u64).read_to_end(&mut data).map_err(|_|"Cannot read selected file")?;
        ordinary(path)?;if data.len()!=meta.len() as usize{return Err("Selected file changed while reading".into());}
        inputs.push((path.file_name().and_then(|n|n.to_str()).ok_or("Invalid filename")?.to_owned(),data));
    }
    capture_buffers(root,session,inputs)
}
fn capture_buffers(root:&Path,session:&str,inputs:Vec<(String,Vec<u8>)>)->Result<Vec<Attachment>,String>{
    if session.is_empty() || session.len()>128 || !session.bytes().all(|b|b.is_ascii_alphanumeric()||b"-_".contains(&b)){return Err("Invalid conversation identity".into());}
    if inputs.is_empty() || inputs.len()>4{return Err("Select one to four files".into());}
    let mut captured=Vec::new();let mut total=0usize;let mut input_total=0usize;
    for (name,source) in inputs {
        if name.is_empty() || name.len()>160 || name.chars().any(|c|c.is_control()||"\\/".contains(c)){return Err("Invalid filename".into());}
        input_total+=source.len();if source.is_empty() || source.len()>MAX_INPUT || input_total>32*1024*1024{return Err("Use nonempty files up to 16 MiB each and 32 MiB total".into());}
        let data=crate::attachment_documents::extract(&name,&source)?.unwrap_or(source);
        total+=data.len();if data.len()>MAX_FILE||total>MAX_TOTAL{return Err("Images must be at most 8 MiB; attachments at most 24 MiB total".into());}
        let mime=mime(&data).ok_or("Use UTF-8 text/code, PNG, JPEG, WebP, PDF, DOCX, XLSX, XLS, XLSB or ODS")?;
        let ext=Path::new(&name).extension().and_then(|x|x.to_str()).unwrap_or("").to_ascii_lowercase();
        let expected=match ext.as_str(){"png"=>Some("image/png"),"jpg"|"jpeg"=>Some("image/jpeg"),"webp"=>Some("image/webp"),_=>None};
        if expected.is_some_and(|value|value!=mime){return Err("The image contents do not match its file type".into());}
        let id=uuid::Uuid::new_v4().to_string();let sha256=format!("{:x}",Sha256::digest(&data));
        captured.push((Attachment{version:1,id,session_id:session.into(),name,mime:mime.into(),bytes:data.len(),sha256,preview_url:None},data));
    }
    fs::create_dir_all(root).map_err(|_| "Attachment storage is unavailable")?;
    ordinary(root)?;
    let mut created = Vec::new();
    let result = (|| {
        for (a, data) in &captured {
            for (path, bytes) in [
                (root.join(format!("{}.bin", a.id)), data.clone()),
                (
                    root.join(format!("{}.json", a.id)),
                    serde_json::to_vec(a).map_err(|_| "Attachment metadata is invalid")?,
                ),
            ] {
                let mut file = OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&path)
                    .map_err(|_| "Cannot save attachment")?;
                created.push(path);
                file.write_all(&bytes)
                    .and_then(|_| file.sync_all())
                    .map_err(|_| "Cannot save attachment")?;
            }
        }
        // Preview bytes are returned only to the selecting UI; metadata stays compact.
        Ok(captured.into_iter().map(|(mut a, data)| {
            if a.mime.starts_with("image/") {
                a.preview_url=Some(format!("data:{};base64,{}",a.mime,base64::engine::general_purpose::STANDARD.encode(data)));
            }
            a
        }).collect())
    })();
    if result.is_err() {
        for path in created {
            let _ = fs::remove_file(path);
        }
    }
    result
}
#[tauri::command]
pub(crate) async fn attachments_pick(session_id: String) -> Result<Vec<Attachment>, String> {
    let files = rfd::AsyncFileDialog::new()
        .set_title("Attach images, documents or code to this conversation")
        .add_filter(
            "Images, documents and code",
            &[
                "txt", "md", "csv", "json", "xml", "html", "css", "js", "ts", "rs", "py", "yaml",
                "yml", "png", "jpg", "jpeg", "webp", "pdf", "docx", "xlsx", "xls", "xlsb", "ods", "log", "sql", "c", "cpp", "h", "cs", "java", "go", "jsx", "tsx", "toml", "sh", "ps1",
            ],
        )
        .pick_files()
        .await;
    let Some(files) = files else {
        return Ok(Vec::new());
    };
    let settings = crate::workspace_controls::engine_settings_path()?;
    let root = settings
        .parent()
        .ok_or("Attachment storage is unavailable")?
        .join("attachments-v1");
    capture(
        &root,
        &session_id,
        &files
            .into_iter()
            .map(|f| f.path().to_owned())
            .collect::<Vec<_>>(),
    )
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase")]
pub(crate) struct ImportedFile { name:String, data_base64:String }
#[tauri::command]
pub(crate) async fn attachments_import(session_id:String,files:Vec<ImportedFile>)->Result<Vec<Attachment>,String>{
    if files.is_empty()||files.len()>4{return Err("Select one to four files".into());}
    if files.iter().any(|f|f.data_base64.len()>((MAX_INPUT+2)/3)*4)||files.iter().map(|f|f.data_base64.len()).sum::<usize>()>45*1024*1024{return Err("Attachment input is too large".into());}
    let settings=crate::workspace_controls::engine_settings_path()?;let root=settings.parent().ok_or("Attachment storage is unavailable")?.join("attachments-v1");
    tauri::async_runtime::spawn_blocking(move || {
        let inputs=files.into_iter().map(|f|base64::engine::general_purpose::STANDARD.decode(f.data_base64).map(|data|(f.name,data)).map_err(|_|"Invalid attachment encoding".to_string())).collect::<Result<Vec<_>,_>>()?;
        capture_buffers(&root,&session_id,inputs)
    }).await.map_err(|_|"The document could not be processed")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_snapshots_are_bounded_and_owned() {
        let root = std::env::temp_dir().join(format!("abdo-attachments-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let source = root.join("note.txt");
        fs::write(&source, "Attachment reference text").unwrap();
        let stored = capture(&root.join("store"), "s-owner", &[source.clone()]).unwrap();
        assert_eq!(stored[0].mime, "text/plain");
        assert_eq!(stored[0].session_id, "s-owner");
        let meta: Attachment = serde_json::from_slice(
            &fs::read(root.join("store").join(format!("{}.json", stored[0].id))).unwrap(),
        )
        .unwrap();
        assert_eq!(
            meta.sha256,
            format!("{:x}", Sha256::digest(b"Attachment reference text"))
        );
        assert!(stored[0].preview_url.is_none());
        let image=include_bytes!("../test-fixtures/attachments/screenshot.png");
        let selected=capture_buffers(&root.join("store"),"s-owner",vec![("screenshot.png".into(),image.to_vec())]).unwrap();
        let preview=selected[0].preview_url.as_ref().unwrap().strip_prefix("data:image/png;base64,").unwrap();
        assert_eq!(base64::engine::general_purpose::STANDARD.decode(preview).unwrap(),image);
        let persisted:Attachment=serde_json::from_slice(&fs::read(root.join("store").join(format!("{}.json",selected[0].id))).unwrap()).unwrap();
        assert!(persisted.preview_url.is_none());
        fs::write(&source, vec![0; MAX_FILE + 1]).unwrap();
        assert!(capture(&root.join("store"), "s-owner", &[source]).is_err());
        assert!(capture(&root.join("store"), "../other", &[]).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn image_magic_and_text_are_not_interchangeable() {
        assert_eq!(mime(b"real UTF-8 text"), Some("text/plain"));
        assert_eq!(mime(&[0, 1, 2, 3]), None);
        let mut png = vec![137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82];
        png.extend_from_slice(&1u32.to_be_bytes());
        png.extend_from_slice(&1u32.to_be_bytes());
        assert_eq!(mime(&png), Some("image/png"));
        png[16..20].copy_from_slice(&9000u32.to_be_bytes());
        assert_eq!(mime(&png), None);
    }
}
