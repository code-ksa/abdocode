//! Read attachment bytes only; document macros, links and formulas are never executed.
use calamine::Reader;
use std::io::{Cursor, Read};
pub(crate) const MAX_TEXT: usize = 128 * 1024;
const MAX_EXPANDED: u64 = 32 * 1024 * 1024;

fn bounded(text: String) -> Result<Vec<u8>, String> {
    if text.trim().is_empty() { return Err("This document has no readable text. Scanned PDFs need OCR before attaching.".into()); }
    if text.len() > MAX_TEXT { return Err("Document text exceeds 128 KiB. Split it into smaller documents.".into()); }
    // Match the engine's UTF-8 snapshot contract, including PDF page separators.
    Ok(text.chars().map(|c| if c.is_control() && !matches!(c, '\n'|'\r'|'\t') { ' ' } else { c }).collect::<String>().into_bytes())
}
fn inspect_zip(data: &[u8]) -> Result<(), String> {
    let mut archive=zip::ZipArchive::new(Cursor::new(data)).map_err(|_| "Invalid Office document archive")?;
    if archive.len()>10_000 { return Err("Document has too many archive entries".into()); }
    let mut size=0u64;
    for i in 0..archive.len() { let f=archive.by_index(i).map_err(|_| "Encrypted or invalid document entry")?;
        size=size.checked_add(f.size()).ok_or("Document is too large")?;
        if size>MAX_EXPANDED { return Err("Expanded document exceeds 32 MiB".into()); }
    }
    Ok(())
}
fn word(data: &[u8]) -> Result<Vec<u8>,String> {
    inspect_zip(data)?;
    let mut archive=zip::ZipArchive::new(Cursor::new(data)).map_err(|_|"Invalid Word document")?;
    let mut xml=String::new();
    archive.by_name("word/document.xml").map_err(|_|"Use a valid DOCX Word document")?.take(MAX_EXPANDED+1).read_to_string(&mut xml).map_err(|_|"Invalid Word XML")?;
    let mut reader=quick_xml::Reader::from_str(&xml);let mut text=String::new();let mut in_text=false;
    loop { match reader.read_event().map_err(|_|"Invalid Word XML")? {
        quick_xml::events::Event::Start(e)=>{ if e.local_name().as_ref()==b"t" {in_text=true;} },
        quick_xml::events::Event::End(e)=>{match e.local_name().as_ref(){b"t"=>in_text=false,b"p"|b"tr"=>text.push('\n'),b"tc"=>text.push('\t'),_=>{}}},
        quick_xml::events::Event::Empty(e)=>{match e.local_name().as_ref(){b"tab"=>text.push('\t'),b"br"|b"cr"=>text.push('\n'),_=>{}}},
        quick_xml::events::Event::Text(e) if in_text=>{text.push_str(&e.unescape().map_err(|_|"Invalid Word text")?);},
        quick_xml::events::Event::DocType(_)=>return Err("Document type declarations are not supported".into()),
        quick_xml::events::Event::Eof=>break,_=>{}
    } if text.len()>MAX_TEXT {return Err("Document text exceeds 128 KiB. Split it into smaller documents.".into());} }
    bounded(text)
}
fn spreadsheet(data: &[u8]) -> Result<Vec<u8>,String> {
    if data.starts_with(b"PK") {inspect_zip(data)?;}
    let mut book=calamine::open_workbook_auto_from_rs(Cursor::new(data)).map_err(|_|"Cannot read this spreadsheet. Use XLSX, XLS, XLSB or ODS without a password.")?;
    let names=book.sheet_names().to_vec();if names.len()>128{return Err("Spreadsheet exceeds 128 sheets".into());}
    let mut text=String::new();let mut cells=0usize;
    for name in names {text.push_str(&format!("\nSheet: {name}\n"));
        let range=book.worksheet_range(&name).map_err(|_|"Cannot read spreadsheet cells")?;
        for row in range.rows(){ for (i,cell) in row.iter().enumerate(){cells+=1;if cells>100_000{return Err("Spreadsheet exceeds 100,000 cells".into());}if i>0{text.push('\t');}text.push_str(&cell.to_string());if text.len()>MAX_TEXT{return Err("Spreadsheet text exceeds 128 KiB. Select fewer rows or sheets.".into());}}text.push('\n');}
    }
    bounded(text)
}
pub(crate) fn extract(name:&str,data:&[u8])->Result<Option<Vec<u8>>,String>{
    let ext=name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str(){
        "pdf"=>{if !data.starts_with(b"%PDF-"){return Err("File contents do not match PDF".into());}
            let doc=pdf_extract::Document::load_mem(data).map_err(|_|"Cannot open PDF. Remove its password or repair the file.")?;
            if doc.get_pages().len()>200{return Err("PDF exceeds 200 pages. Split it before attaching.".into());}
            bounded(pdf_extract::extract_text_from_mem(data).map_err(|_|"Cannot extract PDF text")?).map(Some)
        },
        "docx"=>word(data).map(Some),
        "xlsx"|"xls"|"xlsb"|"ods"=>spreadsheet(data).map(Some),
        "doc"=>Err("Save legacy Word DOC as DOCX or PDF before attaching.".into()),
        _=>Ok(None)
    }
}

#[cfg(test)]mod tests{
 use super::*;use std::io::Write;
 #[test]fn real_pdf_and_excel_produce_readable_model_input(){
    let pdf=extract("sample.pdf",include_bytes!("../test-fixtures/attachments/sample.pdf")).unwrap().unwrap();
    assert!(String::from_utf8(pdf).unwrap().contains("violet lighthouse forty two"));
    let excel=extract("sample.xlsx",include_bytes!("../test-fixtures/attachments/sample.xlsx")).unwrap().unwrap();
    let text=String::from_utf8(excel).unwrap();assert!(text.contains("Sheet: Quarter"));assert!(text.contains("Copper notebook\t73"));
 }
 #[test]fn real_word_document_is_accepted(){let text=extract("sample.docx",include_bytes!("../test-fixtures/attachments/sample.docx")).unwrap().unwrap();assert!(String::from_utf8(text).unwrap().contains("silver meadow seventy three"));}
 fn archive(files:&[(&str,&str)])->Vec<u8>{let mut zip=zip::ZipWriter::new(Cursor::new(Vec::new()));for(name,text)in files{zip.start_file(*name,zip::write::SimpleFileOptions::default()).unwrap();zip.write_all(text.as_bytes()).unwrap();}zip.finish().unwrap().into_inner()}
 #[test]fn word_content_is_extracted_and_entities_decoded(){let data=archive(&[("word/document.xml",r#"<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>Hello &amp; مرحبا</w:t></w:r></w:p><w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>"#)]);assert_eq!(String::from_utf8(extract("note.docx",&data).unwrap().unwrap()).unwrap(),"Hello & مرحبا\nSecond paragraph\n");}
 #[test]fn malformed_binary_documents_and_large_text_are_rejected(){assert!(extract("bad.pdf",b"not PDF").is_err());assert!(extract("bad.xlsx",b"not Excel").is_err());assert!(extract("bad.docx",b"not Word").is_err());assert!(bounded("a".repeat(MAX_TEXT+1)).is_err());assert!(bounded(" ".into()).is_err());}
 #[test]fn expansion_limit_is_applied_before_xml_read(){let data=archive(&[("word/document.xml",&"x".repeat(MAX_EXPANDED as usize+1))]);assert!(extract("large.docx",&data).unwrap_err().contains("Expanded"));}
}
