import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync('electron/renderer/settings.ts', 'utf8');
const ast = ts.createSourceFile(
  'settings.ts',
  source,
  ts.ScriptTarget.Latest,
  true,
);
const functions = ['renderPluginsPage', 'setPluginEnabledFromSettings'].map(
  name => {
    const declaration = ast.statements.find(
      node => ts.isFunctionDeclaration(node) && node.name?.text === name,
    );
    assert.ok(declaration, `Plugin settings need a working ${name} action`);
    return declaration.getText(ast);
  },
);
let saveCalls = 0;
let failSave = true;
const statuses: string[] = [];
const context = vm.createContext({
  pluginInventory: [
    {
      id: 'sample',
      name: 'Sample',
      enabled: true,
      canToggle: true,
      status: 'configured',
    },
  ],
  pluginSavePending: new Set<string>(),
  pluginFilter: 'all',
  pluginSort: 'name',
  pluginSearchQuery: '',
  pluginInventoryError: '',
  settingsModel: {formatSettingLabel: (key: string) => key},
  studioT: (key: string) => key,
  escSetting: (value: unknown) => String(value ?? ''),
  settingIcon: () => '',
  renderSettings: () => {},
  setSettingsStatus: (_state: string, text: string) => statuses.push(text),
  settingsApi: () => ({
    extensions: {
      setEnabled: async (id: string, enabled: boolean) => {
        saveCalls++;
        if (failSave) {
          return {ok: false, error: 'disk unavailable'};
        }
        return {
          ok: true,
          appliesTo: 'next_task',
          plugins: {
            items: [
              {
                id,
                name: 'Sample',
                enabled,
                canToggle: true,
                status: 'disabled',
              },
            ],
          },
        };
      },
    },
  }),
});
vm.runInContext(
  ts.transpileModule(functions.join('\n'), {
    compilerOptions: {target: ts.ScriptTarget.ES2022},
  }).outputText,
  context,
);
const render = () =>
  vm.runInContext(
    'renderPluginsPage({id:"plugins",title:"Plugins",sections:[]})',
    context,
  ) as string;
assert.match(render(), /data-plugin-toggle="sample"/);
assert.match(render(), /aria-checked="true"/);
assert.doesNotMatch(
  render(),
  /mp-settings-plugin-more/,
  'Do not leave a dead more-actions button',
);
void (async () => {
  await vm.runInContext('setPluginEnabledFromSettings("sample")', context);
  assert.equal(
    context.pluginInventory[0].enabled,
    true,
    'Failed save keeps effective enabled state',
  );
  assert.ok(statuses.includes('disk unavailable'));
  assert.equal(context.pluginSavePending.size, 0);
  failSave = false;
  await vm.runInContext('setPluginEnabledFromSettings("sample")', context);
  assert.equal(context.pluginInventory[0].enabled, false);
  assert.match(render(), /aria-checked="false"/);
  context.pluginInventory[0].canToggle = false;
  await vm.runInContext('setPluginEnabledFromSettings("sample")', context);
  assert.equal(
    saveCalls,
    2,
    'Read-only discovered extensions must not be enabled by this control',
  );
  context.pluginInventoryError = 'Cannot read plugin configuration';
  assert.match(render(), /Cannot read plugin configuration/);
  console.log(
    'Plugin controls: effective state, save failure/retry, read-only entries and errors passed',
  );
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
