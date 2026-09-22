import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
const { DocumentOperationBackend } = require(resolve(process.cwd(), 'build/electron/runtime/actions'));
const { fileSource } = require(resolve(process.cwd(), 'build/electron/runtime/context'));
const { configureDesktop, listWindows, runPowerShellJson, closeDesktop } = require(resolve(process.cwd(), 'build/electron/runtime/desktop'));
type Json = Record<string, any>;
type PatchOperation = Json;

async function main() {
  const root = process.cwd(),
    output = join(root, 'data', `acceptance-office-${Date.now()}`),
    results: Record<string, Json> = {};
  configureDesktop(root);
  await mkdir(output, { recursive: true });
  const script = (data: unknown, body: string) =>
    `$p=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(JSON.stringify(data)).toString('base64')}'))|ConvertFrom-Json\n${body}`;
  for (const app of ['word', 'excel', 'powerpoint']) {
    const path = join(
      output,
      `${app}.${app === 'word' ? 'docx' : app === 'excel' ? 'xlsx' : 'pptx'}`,
    );
    let created: Json = {};
    try {
      created = await runPowerShellJson(
        script(
          { app, path },
          `$prog=if($p.app -eq 'word'){'Word.Application'}elseif($p.app -eq 'excel'){'Excel.Application'}else{'PowerPoint.Application'}
$owned=$false;try{$app=[Runtime.InteropServices.Marshal]::GetActiveObject($prog)}catch{$app=New-Object -ComObject $prog;$owned=$true}
if($p.app -eq 'word'){$doc=$app.Documents.Add();$doc.Content.Text='Keep old ending';$doc.Range(0,5).Bold=-1;$doc.Range(5,8).Italic=-1;$doc.Range(8,15).Underline=1;$doc.SaveAs2([string]$p.path);$hwnd=[int64]$doc.Windows.Item(1).Hwnd;@{hwnd=$hwnd;owned=$owned;path=$p.path}|ConvertTo-Json -Compress}
elseif($p.app -eq 'excel'){$doc=$app.Workbooks.Add();$sheet=$doc.Worksheets.Item(1);$sheet.Range('A1').Value2=0;$sheet.Range('B1').Value2=0;$doc.SaveAs([string]$p.path,51);$sheet.Range('A1').Locked=$false;$sheet.Protect();@{hwnd=[int64]$doc.Windows.Item(1).Hwnd;sheet=[string]$sheet.Name;owned=$owned;path=$p.path}|ConvertTo-Json -Compress}
else{$app.Visible=-1;$doc=$app.Presentations.Add(-1);$slide=$doc.Slides.Add(1,12);$shape=$slide.Shapes.AddShape(1,30,40,200,100);$shape.Fill.Visible=0;$shape.Line.Visible=0;$doc.SaveAs([string]$p.path);@{hwnd=[int64]$doc.Windows.Item(1).HWND;slideId=[int]$slide.SlideID;shapeId=[int]$shape.Id;owned=$owned;path=$p.path}|ConvertTo-Json -Compress}`,
        ),
        undefined,
        30000,
      );
      const source = fileSource('native-office-audit', path);
      source.identity.hwnd = created.hwnd;
      if (app === 'powerpoint') {
        const window = (await listWindows()).find(
          (item: Json) =>
            String(item.title).includes('powerpoint') &&
            /powerpnt/i.test(String(item.process_name)),
        );
        if (window) source.identity.hwnd = window.hwnd;
      }
      const backend = new DocumentOperationBackend([source]),
        operation: PatchOperation = {
          operationId: app,
          sourceId: source.sourceId,
          referenceId: app,
          operation:
            app === 'word'
              ? 'replace_text'
              : app === 'excel'
                ? 'set_cell_values'
                : 'set_shape_style',
          locator: {
            kind: app === 'word' ? 'text' : app === 'excel' ? 'cell-range' : 'slide-shape',
            value:
              app === 'word'
                ? { start: 0, end: 15 }
                : app === 'excel'
                  ? { sheet: created.sheet, range: 'A1:B1' }
                  : { slideId: created.slideId, shapeId: created.shapeId },
          },
          before:
            app === 'word'
              ? 'Keep old ending'
              : app === 'excel'
                ? [[0, 0]]
                : { fillRgb: null, lineRgb: null },
          after:
            app === 'word'
              ? 'Keep longer ending'
              : app === 'excel'
                ? [[1, 2]]
                : { fillRgb: 255, lineRgb: null },
        };
      const result = await backend.execute(operation),
        current = await backend.readCurrent(operation);
      if (app === 'word') {
        const formatting = await runPowerShellJson(
          script(
            { path },
            `$app=[Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application');$doc=$null;foreach($win in $app.Windows){if($win.Document.FullName -eq $p.path){$doc=$win.Document;break}};@{text=[string]$doc.Range([int]0,[int]18).Text;formats=@([int]$doc.Range([int]0,[int]5).Bold,[int]$doc.Range([int]5,[int]11).Italic,[int]$doc.Range([int]11,[int]18).Underline)}|ConvertTo-Json -Compress`,
          ),
        );
        results.word = {
          result,
          formatting,
          passed:
            result.ok &&
            formatting.text === 'Keep longer ending' &&
            JSON.stringify(formatting.formats) === '[-1,-1,1]',
        };
      } else if (app === 'excel')
        results.excel = {
          result,
          current,
          passed:
            result.ok === false &&
            result.wrote === true &&
            JSON.stringify(current.value) === '[[1,0]]',
        };
      else {
        const restored = await backend.execute({
          ...operation,
          operationId: 'restore-style',
          before: operation.after,
          after: operation.before,
        });
        results.powerpoint = { result, restored, passed: result.ok && restored.ok };
      }
    } catch (error) {
      results[app] = { passed: false, error: String(error) };
    } finally {
      if (created.path)
        try {
          await runPowerShellJson(
            script(
              { app, path, owned: created.owned },
              `$prog=if($p.app -eq 'word'){'Word.Application'}elseif($p.app -eq 'excel'){'Excel.Application'}else{'PowerPoint.Application'};$app=[Runtime.InteropServices.Marshal]::GetActiveObject($prog);$collection=if($p.app -eq 'word'){$app.Documents}elseif($p.app -eq 'excel'){$app.Workbooks}else{$app.Presentations};$doc=$null;foreach($candidate in $collection){if($candidate.FullName -eq $p.path){$doc=$candidate;break}};if($doc){if($p.app -eq 'powerpoint'){$doc.Saved=-1;$doc.Close()}elseif($p.app -eq 'word'){$save=0;$doc.Close([ref]$save)}else{$doc.Close($false)}};if($p.owned){$app.Quit()};@{ok=$true}|ConvertTo-Json -Compress`,
            ),
          );
        } catch (error) {
          results[app]!.cleanupError = String(error);
        }
      await writeFile(join(output, 'result.json'), JSON.stringify(results, null, 2));
    }
  }
  console.log(JSON.stringify({ output, results }, null, 2));
  process.exitCode = Object.values(results).every((result) => result.passed === true) ? 0 : 1;
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => closeDesktop());
