// Drawing attributes adapt Thesys' MIT SVG primitives; see
// ../runtime/openui_graphics_NOTICE.txt for attribution and source revisions.
interface GraphicsSchema {
  optional(): GraphicsSchema;
  array(): GraphicsSchema;
  or(other: GraphicsSchema): GraphicsSchema;
}

interface GraphicsObjectSchema extends GraphicsSchema {
  shape: Record<string, GraphicsSchema>;
  pick(keys: Record<string, boolean>): GraphicsObjectSchema;
  extend(shape: Record<string, GraphicsSchema>): GraphicsObjectSchema;
}

interface GraphicsRenderProps {
  props: Record<string, unknown>;
  renderNode(value: unknown): unknown;
}

interface GraphicsComponent {
  name: string;
  props: GraphicsObjectSchema;
  ref: GraphicsSchema;
  description: string;
  component(props: GraphicsRenderProps): unknown;
}

interface GraphicsLibrary {
  components: Record<string, GraphicsComponent>;
  extend(extension: {
    components: {
      add: Array<
        GraphicsComponent | {component: GraphicsComponent; slots: string[]}
      >;
    };
  }): GraphicsLibrary;
  toSpec(): {
    components: Record<string, {signature: string; description?: string}>;
  };
}

interface GraphicsBundle {
  React: {
    createElement(
      type: unknown,
      props: Record<string, unknown>,
      ...children: unknown[]
    ): unknown;
  };
  openuiChatLibrary: unknown;
}

declare global {
  var OpenUIGraphics: {
    extend(bundle: GraphicsBundle): GraphicsLibrary;
  };
}

(() => {
  const libraries = new WeakMap<object, GraphicsLibrary>();
  const finite = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const nonnegative = (value: unknown): number | undefined => {
    const number = finite(value);
    return number === undefined ? undefined : Math.max(0, number);
  };
  const opacity = (value: unknown): number | undefined => {
    const number = finite(value);
    return number === undefined ? undefined : Math.min(1, Math.max(0, number));
  };
  function color(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }
    const candidate = value.trim();
    if (candidate === 'none') {
      return candidate;
    }
    return /^(?:#[\da-f]{3,8}|[a-z]+|(?:rgba?|hsla?)\([\d\s.,%+/-]+\))$/i.test(
      candidate,
    ) && CSS.supports('color', candidate)
      ? candidate
      : undefined;
  }
  function paint(props: Record<string, unknown>, filled: boolean) {
    return {
      fill:
        color(props.fill) ??
        (filled && props.stroke === undefined ? 'currentColor' : 'none'),
      stroke: color(props.stroke) ?? (filled ? undefined : 'currentColor'),
      strokeWidth: nonnegative(props.strokeWidth) ?? (filled ? undefined : 2),
      opacity: opacity(props.opacity),
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    };
  }
  const transformArguments: Record<string, number[]> = {
    translate: [1, 2],
    rotate: [1, 3],
    scale: [1, 2],
    skewX: [1],
    skewY: [1],
    matrix: [6],
  };
  function transform(value: unknown): string | undefined {
    if (typeof value !== 'string' || value.length > 500) {
      return undefined;
    }
    const parts = [...value.matchAll(/\s*([a-zA-Z]+)\(([^()]*)\)\s*/g)];
    if (!parts.length || parts.map(part => part[0]).join('') !== value) {
      return undefined;
    }
    return parts.every(([, name, argumentsText]) => {
      const numbers = argumentsText
        .trim()
        .split(/\s*,\s*|\s+/)
        .filter(Boolean);
      return (
        transformArguments[name]?.includes(numbers.length) &&
        numbers.every(number => Number.isFinite(Number(number)))
      );
    })
      ? value.trim()
      : undefined;
  }

  function extend(bundle: GraphicsBundle): GraphicsLibrary {
    const base = bundle.openuiChatLibrary as GraphicsLibrary;
    const cached = libraries.get(base);
    if (cached) {
      return cached;
    }
    const element = bundle.React.createElement;
    // These are public Zod schemas exposed by the official library. Deriving
    // new objects keeps the vendored parser and its schema registry intact.
    const number = base.components.Slider.props.shape.min;
    const string = base.components.TextContent.props.shape.text;
    const object = (shape: Record<string, GraphicsSchema>) =>
      base.components.TextContent.props.pick({}).extend(shape);
    const define = (
      name: string,
      shape: Record<string, GraphicsSchema>,
      description: string,
      component: GraphicsComponent['component'],
    ): GraphicsComponent => {
      const props = object(shape);
      return {name, props, ref: props, description, component};
    };
    const paintFields = {
      fill: string.optional(),
      stroke: string.optional(),
      strokeWidth: number.optional(),
      opacity: number.optional(),
    };
    const circle = define(
      'SvgCircle',
      {cx: number, cy: number, r: number, ...paintFields},
      'Circle. Numeric properties accept expressions using reactive $variables.',
      ({props}) =>
        element('circle', {
          cx: finite(props.cx),
          cy: finite(props.cy),
          r: nonnegative(props.r),
          ...paint(props, true),
        }),
    );
    const rectangle = define(
      'SvgRect',
      {
        x: number,
        y: number,
        width: number,
        height: number,
        ...paintFields,
        rx: number.optional(),
      },
      'Rectangle; rx optionally rounds the corners.',
      ({props}) =>
        element('rect', {
          x: finite(props.x),
          y: finite(props.y),
          width: nonnegative(props.width),
          height: nonnegative(props.height),
          rx: nonnegative(props.rx),
          ...paint(props, true),
        }),
    );
    const line = define(
      'SvgLine',
      {
        x1: number,
        y1: number,
        x2: number,
        y2: number,
        stroke: string.optional(),
        strokeWidth: number.optional(),
        opacity: number.optional(),
      },
      'Line between two points; distinct from chart components.',
      ({props}) =>
        element('line', {
          x1: finite(props.x1),
          y1: finite(props.y1),
          x2: finite(props.x2),
          y2: finite(props.y2),
          ...paint(props, false),
        }),
    );
    const drawingPath = define(
      'SvgPath',
      {d: string, ...paintFields},
      'SVG path commands such as M, L, C, Q, A and Z. No markup or URLs.',
      ({props}) =>
        element('path', {
          d:
            typeof props.d === 'string' &&
            props.d.length < 20000 &&
            /^[MmLlHhVvCcSsQqTtAaZz\d\s,.eE+-]*$/.test(props.d)
              ? props.d
              : undefined,
          ...paint(props, props.fill !== undefined),
        }),
    );
    const drawingText = define(
      'SvgText',
      {
        text: string,
        x: number,
        y: number,
        size: number.optional(),
        fill: string.optional(),
        anchor: string.optional(),
      },
      'Plain text in the drawing. anchor is start, middle or end. Use expressions for live numeric labels.',
      ({props}) =>
        element(
          'text',
          {
            x: finite(props.x),
            y: finite(props.y),
            fontSize: nonnegative(props.size) ?? 12,
            fill: color(props.fill) ?? 'currentColor',
            textAnchor: ['start', 'middle', 'end'].includes(
              String(props.anchor),
            )
              ? props.anchor
              : 'start',
            fontFamily: 'inherit',
          },
          String(props.text ?? ''),
        ),
    );
    const shapes = [circle, rectangle, line, drawingPath, drawingText];
    const shape = shapes
      .slice(1)
      .reduce((union, item) => union.or(item.ref), circle.ref);
    const group = define(
      'SvgGroup',
      {
        children: shape.array(),
        transform: string.optional(),
        opacity: number.optional(),
      },
      'Group shapes with translate, rotate, scale, skewX, skewY or matrix. Groups may nest.',
      ({props, renderNode}) =>
        element(
          'g',
          {
            transform: transform(props.transform),
            opacity: opacity(props.opacity),
          },
          renderNode(props.children),
        ),
    );
    const svg = define(
      'Svg',
      {
        children: shape.or(group.ref).array(),
        viewBox: string,
        width: number.optional(),
        height: number.optional(),
        label: string.optional(),
      },
      'Responsive local drawing. viewBox is four numbers: minX minY width height. Dimensions are optional pixels; label describes the diagram. Paint accepts CSS colors, currentColor or none; URLs are not supported.',
      ({props, renderNode}) => {
        const bounds = String(props.viewBox)
          .trim()
          .split(/[\s,]+/)
          .map(Number);
        const valid =
          bounds.length === 4 &&
          bounds.every(Number.isFinite) &&
          bounds[2] > 0 &&
          bounds[3] > 0;
        return element(
          'svg',
          {
            viewBox: valid ? bounds.join(' ') : '0 0 100 100',
            role: 'img',
            'aria-label': String(props.label || 'Drawing'),
            preserveAspectRatio: 'xMidYMid meet',
            style: {
              display: 'block',
              width: nonnegative(props.width) ?? '100%',
              height: nonnegative(props.height) ?? 'auto',
              maxWidth: '100%',
            },
          },
          renderNode(props.children),
        );
      },
    );
    const library = base.extend({
      components: {
        add: [
          ...shapes,
          {component: group, slots: ['SvgGroup.children']},
          {
            component: svg,
            slots: [
              'Card.children',
              'SectionItem.content',
              'TabItem.content',
              'AccordionItem.content',
            ],
          },
        ],
      },
    });
    libraries.set(base, library);
    return library;
  }

  globalThis.OpenUIGraphics = {extend};
})();
