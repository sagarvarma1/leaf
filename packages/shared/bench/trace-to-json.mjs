// Parse the editing trace as data (no eval): the edits array and finalText are JSON-compatible literals.
import fs from "node:fs";
const [src, out] = process.argv.slice(2);
const text = fs.readFileSync(src, "utf8");
const a = text.indexOf("[", text.indexOf("const edits ="));
const aEnd = text.indexOf("];", a) + 1;
const edits = JSON.parse(text.slice(a, aEnd));
const f = text.indexOf('"', text.indexOf("const finalText ="));
const fEnd = text.lastIndexOf('";') + 1;
const finalText = JSON.parse(text.slice(f, fEnd));
fs.writeFileSync(out, JSON.stringify({ edits, finalText }));
console.log(edits.length, "edits;", finalText.length, "chars final");
