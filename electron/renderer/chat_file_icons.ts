// The retained asset carries @pierre/trees' copyright and Apache-2.0 license.
export type FileIconNode = [string, Record<string, string>, FileIconNode[]?];
interface FileIconSet {
  defaultIcon: string;
  fileNames: Record<string, string>;
  fileExtensions: Record<string, string>;
  icons: Record<string, string>;
  palette: Record<string, [string, string]>;
}
const iconSet: FileIconSet = require('./assets/file-type-icons.json');
const parsed = new Map<string, FileIconNode[]>();

const CATEGORY_GLYPHS = {
  Archive: 57352,
  Code: 57416,
  Database: 57436,
  Globe: 57474,
  Image: 57484,
  Note: 57523,
  Scroll: 57554,
  Slides: 57570,
  Spreadsheet: 57574,
} as const;
const CODE_EXTENSIONS = new Set(
  (
    'js.jsx.gs.ts.tsx.py.rb.go.rs.c.cpp.h.hpp.java.kt.swift.sh.bash.zsh.json.yaml.yml.toml.xml.html.css.scss.sql.graphql.proto.lua.r.' +
    'cs.vue.pl.php.htm.xhtml.' +
    'python.javascript.typescript.csharp.rust.ruby.kotlin.dart.scala.perl.elixir.haskell.clojure.groovy.less.plaintext'
  ).split('.'),
);

function fallbackIconName(
  name: string,
): keyof typeof CATEGORY_GLYPHS | undefined {
  const extension = name.includes('.') ? name.split('.').pop()! : '';
  if (name.includes('SKILL.md') || ['skill', 'plugin'].includes(extension)) {
    return 'Scroll';
  }
  if (['md', 'markdown'].includes(extension)) {
    return 'Note';
  }
  if (['html', 'htm', 'xhtml'].includes(extension)) {
    return 'Globe';
  }
  if (
    ['zip', 'tar', 'gz', 'bz2', 'xz', '7z', 'rar', 'tgz'].includes(extension)
  ) {
    return 'Archive';
  }
  if (['ppt', 'pptx'].includes(extension)) {
    return 'Slides';
  }
  if (['jsonl', 'parquet', 'db', 'sqlite', 'sqlite3'].includes(extension)) {
    return 'Database';
  }
  if (['csv', 'tsv', 'xls', 'xlsx'].includes(extension)) {
    return 'Spreadsheet';
  }
  if (CODE_EXTENSIONS.has(extension)) {
    return 'Code';
  }
  if (
    [
      'ico',
      'svg',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'bmp',
      'webp',
      'mermaid',
      'mmd',
    ].includes(extension)
  ) {
    return 'Image';
  }
  return undefined;
}

export function fileIconFor(fileName: string): {
  id: string;
  nodes: FileIconNode[];
  glyph?: string;
} {
  const baseName = fileName.replace(/\\/g, '/').split('/').pop()!;
  const name = baseName.toLowerCase();
  let id = Object.hasOwn(iconSet.fileNames, name)
    ? iconSet.fileNames[name]
    : '';
  for (
    let dot = name.indexOf('.');
    !id && dot !== -1;
    dot = name.indexOf('.', dot + 1)
  ) {
    const extension = name.slice(dot + 1);
    if (Object.hasOwn(iconSet.fileExtensions, extension)) {
      id = iconSet.fileExtensions[extension];
    }
  }
  if (!id) {
    const category = fallbackIconName(
      baseName.includes('SKILL.md') ? baseName : name,
    );
    if (category) {
      return {
        id: category,
        nodes: [],
        glyph: String.fromCodePoint(CATEGORY_GLYPHS[category]),
      };
    }
  }
  id ||= iconSet.defaultIcon;
  let nodes = parsed.get(id);
  if (!nodes) {
    const resolve = (raw: FileIconNode[]): FileIconNode[] =>
      raw.map(([tag, attributes, children]) => {
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(attributes)) {
          const color = value.startsWith('$')
            ? iconSet.palette[value.slice(1)]
            : undefined;
          values[key] = color ? `light-dark(${color[0]}, ${color[1]})` : value;
        }
        return [tag, values, children ? resolve(children) : undefined];
      });
    nodes = resolve(JSON.parse(iconSet.icons[id]) as FileIconNode[]);
    parsed.set(id, nodes);
  }
  return {id, nodes};
}
