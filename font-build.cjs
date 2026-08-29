// Builds the ZHIPU logo icon font (media/glm-logo.woff|woff2) from
// font-src/zhipu.svg. Run once: `node font-build.cjs`.
//
// NOTE: uses svgicons2svgfont/svg2ttf/ttf2woff(2) directly. The fantasticon
// wrapper is unusable on Windows (glob v13 only matches forward-slash
// patterns while it builds them with path.join → backslashes → no SVGs found).
const fs = require('fs');
const path = require('path');

const root = __dirname;
const mediaDir = path.join(root, 'media');
if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir);
}

const {SVGIcons2SVGFontStream} = require('svgicons2svgfont');
const svg2ttf = require('svg2ttf');
const ttf2woff = require('ttf2woff');
const ttf2woff2 = require('ttf2woff2').default;

const glyphName = 'zhipu';
const codepoint = 0xe001;

// 1. SVG paths → SVG font stream.
const svgFontStream = new SVGIcons2SVGFontStream({
  fontName: 'glm-logo',
  fontHeight: 560,
  normalize: true,
  log: () => {},
  error: message => {
    throw new Error(message);
  },
});

const chunks = [];
svgFontStream.on('data', chunk =>
  // The stream may emit strings; normalize everything to Buffers.
  chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
);

const done = new Promise((resolve, reject) => {
  svgFontStream.on('end', resolve);
  svgFontStream.on('error', reject);
});

const glyphFile = path.join(root, 'font-src', 'zhipu.svg');
const glyphStream = fs.createReadStream(glyphFile);
glyphStream.metadata = {
  name: glyphName,
  unicode: [String.fromCodePoint(codepoint)],
};
svgFontStream.write(glyphStream);
svgFontStream.end();

done
  .then(() => {
    // 2. SVG font → TTF.
    const svgFont = Buffer.concat(chunks).toString('utf8');
    const ttf = Buffer.from(svg2ttf(svgFont, {}).buffer);

    // 3. TTF → WOFF2 + WOFF.
    fs.writeFileSync(
      path.join(mediaDir, 'glm-logo.woff2'),
      Buffer.from(ttf2woff2(new Uint8Array(ttf)).buffer),
    );
    fs.writeFileSync(
      path.join(mediaDir, 'glm-logo.woff'),
      Buffer.from(ttf2woff(new Uint8Array(ttf)).buffer),
    );

    // 4. Codepoint manifest for reference.
    fs.writeFileSync(
      path.join(mediaDir, 'glm-logo.json'),
      JSON.stringify({codepoints: {[glyphName]: codepoint}}, null, 2),
    );

    console.log(
      'Generated:',
      fs
        .readdirSync(mediaDir)
        .map(f => `${f} (${fs.statSync(path.join(mediaDir, f)).size}b)`),
    );
  })
  .catch(error => {
    console.error(error);
    process.exit(1);
  });
