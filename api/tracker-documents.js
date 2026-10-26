import crypto from "node:crypto";
import { fail, text, url, date } from "./tracker-domain.js";

export const DOCUMENT_COLUMNS =
  "id,task_id,kind,title,version,document_date,received_at,source_url,file_name,mime_type,sha256,is_current,approved_at,approval_evidence,event_id,octet_length(file_bytes) AS file_size";
const types = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  txt: "text/plain",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
};
export function validateDocument(body) {
  if (!body || !["az", "st", "estimate", "other"].includes(body.kind))
    fail("Выберите тип документа");
  const doc = {
    kind: body.kind,
    title: text(body.title, 500),
    version: text(body.version, 100),
    document_date: date(body.document_date)?.slice(0, 10) || null,
    source_url: url(body.source_url),
  };
  if (!doc.title || !doc.version) fail("Нужны название и версия документа");
  if (body.file_base64 != null) {
    const name = text(body.file_name, 240);
    if (!name || /[\\/\x00-\x1f]/.test(name) || name === "." || name === "..")
      fail("Некорректное имя файла");
    const ext = name.split(".").pop().toLowerCase();
    if (!types[ext]) fail("Этот формат файла не поддерживается");
    if (
      typeof body.file_base64 !== "string" ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
        body.file_base64,
      )
    )
      fail("Некорректные данные файла");
    const bytes = Buffer.from(body.file_base64, "base64");
    if (!bytes.length || bytes.length > 10485760)
      fail("Размер файла должен быть от 1 байта до 10 МБ");
    const prefix = bytes.subarray(0, 8).toString("hex");
    if (
      (ext === "pdf" && bytes.subarray(0, 5).toString() !== "%PDF-") ||
      (["docx", "xlsx"].includes(ext) && !prefix.startsWith("504b0304")) ||
      (["doc", "xls"].includes(ext) && prefix !== "d0cf11e0a1b11ae1") ||
      (ext === "png" && prefix !== "89504e470d0a1a0a") ||
      (["jpg", "jpeg"].includes(ext) && !prefix.startsWith("ffd8ff")) ||
      (ext === "txt" && bytes.includes(0))
    )
      fail("Содержимое не соответствует типу файла");
    Object.assign(doc, {
      file_name: name,
      mime_type: types[ext],
      file_bytes: bytes,
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (!doc.source_url && !doc.file_bytes)
    fail("Нужен файл или ссылка на источник");
  return doc;
}
export async function insertDocument(client, taskId, eventId, doc) {
  const keys = ["task_id", "event_id", ...Object.keys(doc)];
  const result = await client.query(
    `INSERT INTO task_documents(${keys.join(",")}) VALUES(${keys.map((_, i) => `$${i + 1}`).join(",")}) RETURNING ${DOCUMENT_COLUMNS}`,
    [taskId, eventId, ...Object.values(doc)],
  );
  return result.rows[0];
}
