// PowerPoint TextRange.Runs uses one-based positions; patch spans use zero-based
// positions in TextRange.Text, including paragraph marks.
export const POWERPOINT_TEXT_STYLE_SCRIPT = String.raw`
function Read-MpTextStyles($range) {
  $spans = @()
  $offset = 0
  for ($index = 1; $offset -lt [int]$range.Length; $index++) {
    $run = $range.Runs($index, 1)
    $start = [int]$run.Start - 1
    $length = [int]$run.Length
    if ($start -ne $offset -or $length -le 0) { throw 'powerpoint_style_read_incomplete' }
    $font = $run.Font
    $span = [ordered]@{
      start = $start
      length = $length
      bold = ([int]$font.Bold -eq -1)
      italic = ([int]$font.Italic -eq -1)
      underline = ([int]$font.Underline -eq -1)
      fontName = [string]$font.Name
      fontSize = [double]$font.Size
      colorRgb = [int64]$font.Color.RGB
    }
    $previous = if ($spans.Count) { $spans[-1] } else { $null }
    if ($null -ne $previous -and
        $previous.bold -eq $span.bold -and $previous.italic -eq $span.italic -and
        $previous.underline -eq $span.underline -and $previous.fontName -ceq $span.fontName -and
        $previous.fontSize -eq $span.fontSize -and $previous.colorRgb -eq $span.colorRgb) {
      $previous.length += $length
    } else { $spans += $span }
    $offset += $length
  }
  return $spans
}
`;
