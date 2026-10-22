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

export function fileIconFor(fileName: string): {
  id: string;
  nodes: FileIconNode[];
} {
  const name = fileName.replace(/\\/g, '/').split('/').pop()!.toLowerCase();
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
