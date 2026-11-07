#target photoshop
var OUT = Folder.temp.fsName.split("\\").join("/") + "/msa-editor-test/";
new Folder(OUT).create();
app.displayDialogs = DialogModes.NO;
app.preferences.rulerUnits = Units.PIXELS;
var log = [];
function s2t(s) { return stringIDToTypeID(s); }
function saveWebp(name, lossless, quality) {
  try {
    var fmt = new ActionDescriptor();
    fmt.putEnumerated(s2t("compression"), s2t("WebPCompression"), s2t(lossless ? "compressionLossless" : "compressionLossy"));
    if (!lossless) fmt.putInteger(s2t("quality"), quality);
    fmt.putBoolean(s2t("includeXMPData"), false);
    fmt.putBoolean(s2t("includeEXIFData"), false);
    fmt.putBoolean(s2t("includePsExtras"), false);
    var d = new ActionDescriptor();
    d.putObject(s2t("as"), s2t("WebPFormat"), fmt);
    d.putPath(s2t("in"), new File(OUT + name));
    d.putBoolean(s2t("copy"), true);
    executeAction(s2t("save"), d, DialogModes.NO);
    log.push("ok " + name);
  } catch (e) { log.push("webp " + name + " failed: " + e); }
}
function solid(r, g, b) { var c = new SolidColor(); c.rgb.red = r; c.rgb.green = g; c.rgb.blue = b; return c; }
function rect(doc, x0, y0, x1, y1) { doc.selection.select([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]); }

var a = app.documents.add(64, 64, 72, "msa-a", NewDocumentMode.RGB, DocumentFill.TRANSPARENT);
app.foregroundColor = solid(255, 0, 0);
a.selection.selectAll(); a.selection.fill(app.foregroundColor); a.selection.deselect();
rect(a, 0, 0, 32, 64); a.selection.clear(); a.selection.deselect();
saveWebp("a-transparent-lossless.webp", true, 100);
a.close(SaveOptions.DONOTSAVECHANGES);

var c = app.documents.add(64, 64, 72, "msa-c", NewDocumentMode.RGB, DocumentFill.WHITE);
app.foregroundColor = solid(0, 0, 0);
c.selection.selectAll(); c.selection.fill(app.foregroundColor); c.selection.deselect();
app.foregroundColor = solid(255, 255, 255);
rect(c, 8, 32, 56, 33); c.selection.fill(app.foregroundColor); c.selection.deselect();
saveWebp("c-line-lossless.webp", true, 100);
saveWebp("c-line-q75.webp", false, 75);
saveWebp("c-line-q30.webp", false, 30);
c.close(SaveOptions.DONOTSAVECHANGES);

var f = new File(OUT + "log-webp.txt"); f.open("w"); f.write(log.join("\n")); f.close();
