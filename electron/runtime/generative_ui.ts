import {readFile} from 'node:fs/promises';
import path from 'node:path';
import type {RuntimePlugin, PromptSections} from './agent_plugins';

export function generativeUiPlugin(): RuntimePlugin {
  return {
    name: 'generative-ui',
    inject: ['tools', 'prompt'],
    apply(ctx) {
      ctx.get<PromptSections>('prompt').add({
        id: 'generative-ui',
        order: 80,
        render: () =>
          'When interactive charts, diagrams, adjustable calculations, forms, or comparisons would help, discover and call UI.describe before producing an inline OpenUI interface. Use the task’s actual data. Ordinary answers remain Markdown.',
      });
      ctx.registerTool({
        name: 'UI.describe',
        description:
          'Get the exact OpenUI language and component library for interactive charts, SVG diagrams, tables, forms, sliders and local calculations inside this conversation. Call before generating an interface. User interactions can continue this same task.',
        deferred: true,
        effect: 'read',
        used_backend: 'local.openui-library',
        input_schema: {
          type: 'object',
          properties: {
            topic: {type: 'string', enum: ['overview', 'syntax', 'components', 'actions', 'functions']},
            components: {type: 'array', items: {type: 'string'}},
            offset: {type: 'integer', minimum: 0},
          },
          required: [],
        },
        execute: async args => {
          const library = await readFile(
            path.join(__dirname, '..', 'vendor', 'openui', 'system-prompt.txt'),
            'utf8',
          );
          const graphics = await readFile(path.join(__dirname, 'openui_graphics_prompt.txt'), 'utf8');
          const definitions = new Map<string, string>();
          for (const line of `${library}\n${graphics}`.split(/\r?\n/)) {
            if (/^[A-Z]\w*\(/.test(line)) {
              definitions.set(line.slice(0, line.indexOf('(')), line);
            }
          }
          const signatures = [...definitions.values()];
          const names = signatures.map(line => line.slice(0, line.indexOf('(')));
          const topic = String(args.topic || (args.components ? 'components' : 'overview'));
          let content: string;
          if (topic === 'components') {
            const requested = Array.isArray(args.components) ? args.components.map(String) : [];
            const unknown = requested.filter(name => !names.includes(name));
            if (unknown.length) {
              throw new Error(`Unknown OpenUI components: ${unknown.join(', ')}. Read overview for available names.`);
            }
            content = requested.length
              ? signatures.filter(line => requested.includes(line.slice(0, line.indexOf('(')))).join('\n')
              : names.join(', ');
          } else if (topic === 'syntax') {
            content = library.slice(library.indexOf('## Syntax Rules'), library.indexOf('## Component'));
          } else if (topic === 'actions') {
            content = library.slice(library.indexOf('## Action — Button Behavior'));
          } else if (topic === 'functions') {
            content = library.slice(library.indexOf('## Built-in Functions'), library.indexOf('## Action — Button Behavior'));
          } else {
            content = [
              'Write interactive responses in fenced ```openui blocks in your final answer. Markdown around a block is allowed. Each block is independent and defines root.',
              'OpenUI is declarative, not HTML/JavaScript. Statements are one per line: name = Component(positional, arguments). References can be defined later. Use only the library components below; read topic=components with their exact names before using them.',
              '$variables hold reactive state. @Set/@Reset update locally. @ToAssistant(message, context) submits a real user message with current form values to this same task.',
              'Query/Mutation are not exposed. Read real data through ordinary Runtime tools first. Do not invent fetched values; label estimates and provide sources. Use the user’s language for labels.',
              'Example:\nroot = Card([title, buttons])\n$count = 1\ntitle = TextContent("Count " + $count)\nbuttons = Buttons([increment, send])\nincrement = Button("Increment", @Set($count, $count + 1))\nsend = Button("Continue", @ToAssistant("Continue", {count: $count}))',
              `Available components: ${names.join(', ')}`,
              'Read topic=syntax, topic=actions or topic=functions for full language rules. Follow nextOffset with the same topic/components when a response is paged.',
            ].join('\n\n');
          }
          const offset = Math.min(Number(args.offset || 0), content.length);
          const end = Math.min(offset + 3500, content.length);
          return {topic, content: content.slice(offset, end), nextOffset: end < content.length ? end : null};
        },
      });
    },
  };
}
