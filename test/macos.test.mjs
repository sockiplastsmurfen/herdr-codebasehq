// The attachment dialog's pages, made for real with macOS's tools (PDFKit, the text system,
// Quick Look), and Download. Skipped elsewhere than macOS. All files are made for the test.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { check } from "./lib.mjs";
import { world } from "./fake/herdr.mjs";

if (process.platform !== "darwin") { console.log("  skipped: not macOS"); process.exit(0); }
const { attachmentView, saveToDownloads } = await import("../mods/codebasehq/codebase.js");
world.real = true;
const app = mkdtempSync(`${tmpdir()}/codebasehq-app-`);
process.env.HOME = mkdtempSync(`${tmpdir()}/codebasehq-home-`);
mkdirSync(`${process.env.HOME}/Downloads`);
const creds = { user: "example/alex" };
// An attachment "already downloaded": in place, so nothing asks Codebase.
const place = (id, name, from) => { mkdirSync(`${app}/data/codebasehq-files/${id}`, { recursive: true }); const to = `${app}/data/codebasehq-files/${id}/${name}`; from ? copyFileSync(from, to) : null; return to; };
try {
  const html = `${app}/sample.html`;
  writeFileSync(html, `<html><head><meta charset="utf-8"></head><body>${Array.from({ length: 12 }, (_, i) => `<h2>Section ${i + 1}</h2><p>${"Invented text for a long document, with åäö. ".repeat(40)}</p>`).join("")}</body></html>`);
  const docx = place("00000000000000000001", "Long report å.docx");
  execFileSync("textutil", ["-convert", "docx", "-output", docx, html]);
  let v = await attachmentView(creds, app, "00000000000000000001", "Long report å.docx");
  check("a Word document is laid out on pages", v.kind === "pages" && v.count > 1 && v.pages.length === v.count && existsSync(`${app}/${v.pages[0].path}`), v);
  check("… 1400px wide, A4-shaped", v.pages[0].width === 1400 && Math.abs(v.pages[0].height / v.pages[0].width - 842 / 595) < 0.02, v.pages[0]);

  const drawn = statSync(`${app}/${v.pages[0].path}`).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  const again = await attachmentView(creds, app, "00000000000000000001", "Long report å.docx");
  check("opened again, the pages aren't drawn again", again.pages.length === v.pages.length && statSync(`${app}/${again.pages[0].path}`).mtimeMs === drawn);

  place("00000000000000000002", "Report.pdf", `${app}/data/codebasehq-files/00000000000000000001/layout.pdf`);
  v = await attachmentView(creds, app, "00000000000000000002", "Report.pdf");
  check("a PDF's pages are drawn", v.kind === "pages" && v.pages.length === v.count && v.count > 1, v);

  writeFileSync(place("00000000000000000003", "notes.txt"), "line one\nline två\n");
  v = await attachmentView(creds, app, "00000000000000000003", "notes.txt");
  check("a text file is text", v.kind === "text" && v.text.includes("line två"));

  writeFileSync(place("00000000000000000004", "diagram.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#7aa2f7"/></svg>');
  v = await attachmentView(creds, app, "00000000000000000004", "diagram.svg");
  check("other files get Quick Look's first page", v.kind === "first" && existsSync(`${app}/${v.pages[0].path}`), v);

  copyFileSync(`${app}/${v.pages[0].path}`, place("00000000000000000005", "image"));
  let saved = await saveToDownloads(creds, app, "00000000000000000005", "image");
  check("Download saves in Downloads; a picture without an extension gets its format's", saved.endsWith("/Downloads/image.png"), saved);
  saved = await saveToDownloads(creds, app, "00000000000000000005", "image");
  check("… and doesn't overwrite: (2)", saved.endsWith("/Downloads/image (2).png") && readdirSync(`${process.env.HOME}/Downloads`).length === 2, saved);
} finally {
  rmSync(app, { recursive: true, force: true });
  rmSync(process.env.HOME, { recursive: true, force: true });
}
