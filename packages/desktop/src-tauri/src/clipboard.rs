//! حافظةُ النظام للطرفيّة — 10-09.
//!
//! `navigator.clipboard.readText` في WebView2 يحتاج إذنَ قراءةٍ لا تمنحه القدرةُ الافتراضيّة، فكان اللصقُ يفشل بصمت.
//! نصٌّ يونيكوديّ وحده (CF_UNICODETEXT) — لا صور ولا ملفّات، ولا يُقرأ إلا بفعل المستخدم في الطرفيّة.

#[cfg(windows)]
mod imp {
    use windows_sys::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardData, OpenClipboard, SetClipboardData};
    use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    const CF_UNICODETEXT: u32 = 13;

    /// الحافظةُ مقفلةٌ لحظةً عند برنامجٍ آخر أحياناً — محاولاتٌ قصيرة قبل الاستسلام.
    fn open() -> Result<(), String> {
        for _ in 0..10 {
            if unsafe { OpenClipboard(std::ptr::null_mut()) } != 0 { return Ok(()); }
            std::thread::sleep(std::time::Duration::from_millis(15));
        }
        Err("الحافظة مشغولة ببرنامجٍ آخر".into())
    }

    pub fn read() -> Result<String, String> {
        open()?;
        let result = unsafe {
            let handle = GetClipboardData(CF_UNICODETEXT);
            if handle.is_null() { Ok(String::new()) } else {
                let ptr = GlobalLock(handle) as *const u16;
                if ptr.is_null() { Err("تعذّر قفل الحافظة".to_string()) } else {
                    let mut len = 0usize;
                    while *ptr.add(len) != 0 { len += 1; }
                    let text = String::from_utf16_lossy(std::slice::from_raw_parts(ptr, len));
                    GlobalUnlock(handle);
                    Ok(text)
                }
            }
        };
        unsafe { CloseClipboard(); }
        result
    }

    pub fn write(text: &str) -> Result<(), String> {
        let wide: Vec<u16> = text.encode_utf16().chain(std::iter::once(0)).collect();
        open()?;
        let result = unsafe {
            EmptyClipboard();
            let mem = GlobalAlloc(GMEM_MOVEABLE, wide.len() * 2);
            if mem.is_null() { Err("تعذّر حجز ذاكرة الحافظة".to_string()) } else {
                let ptr = GlobalLock(mem) as *mut u16;
                std::ptr::copy_nonoverlapping(wide.as_ptr(), ptr, wide.len());
                GlobalUnlock(mem);
                // بعد النجاح يملك النظامُ الذاكرة — لا تُحرَّر هنا.
                if SetClipboardData(CF_UNICODETEXT, mem).is_null() { Err("رفض النظام الكتابة في الحافظة".to_string()) } else { Ok(()) }
            }
        };
        unsafe { CloseClipboard(); }
        result
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn read() -> Result<String, String> { Err("حافظةُ النظام مدعومةٌ على ويندوز وحده".into()) }
    pub fn write(_text: &str) -> Result<(), String> { Err("حافظةُ النظام مدعومةٌ على ويندوز وحده".into()) }
}

/// سقفٌ للنصّ الملصوق/المنسوخ: الطرفيّةُ لا تحتاج أكثر، ولصقٌ ضخمٌ بالخطأ لا يغرق الصدفة.
const MAX_CHARS: usize = 1_000_000;

#[tauri::command]
pub fn clipboard_read_text() -> Result<String, String> {
    let text = imp::read()?;
    if text.chars().count() > MAX_CHARS { return Err("النصّ في الحافظة أكبر من مليون حرف".into()); }
    Ok(text)
}

#[tauri::command]
pub fn clipboard_write_text(text: String) -> Result<(), String> {
    if text.chars().count() > MAX_CHARS { return Err("النصّ أكبر من مليون حرف".into()); }
    imp::write(&text)
}
