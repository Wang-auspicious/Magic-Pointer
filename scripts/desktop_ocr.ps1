param([string]$ImagePath,[string]$Language='zh-Hans',[switch]$Resident)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null=[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
$null=[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]
$null=[Windows.Globalization.Language,Windows.Foundation,ContentType=WindowsRuntime]
$asTask=([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
function Await($Operation,[Type]$ResultType){$task=$asTask.MakeGenericMethod($ResultType).Invoke($null,@($Operation));$task.Wait();return $task.Result}
function Read-Image([string]$ImagePath,[string]$Language){
$file=Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
 $decoder=Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 $bitmap=Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 try {
  $languageObject=[Windows.Globalization.Language]::new($Language)
  $engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($languageObject)
  if($null -eq $engine){$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()}
  if($null -eq $engine){throw 'windows_ocr_language_unavailable'}
  $result=Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $blocks=@()
  foreach($line in $result.Lines){foreach($word in $line.Words){$r=$word.BoundingRect;$blocks+=@{text=$word.Text;rect=@([double]$r.X,[double]$r.Y,[double]$r.Width,[double]$r.Height);confidence=$null}}}
  return @{text=$result.Text;blocks=$blocks;engine='windows-ocr';language=$engine.RecognizerLanguage.LanguageTag;coordinateSpace='image_pixels'}
 } finally {$bitmap.Dispose()}
} finally {$stream.Dispose()}
}
if($Resident){
 while($null -ne ($line=[Console]::ReadLine())){
  $request=$null
  try{$request=$line | ConvertFrom-Json;$result=Read-Image $request.path $request.language;@{id=$request.id;result=$result} | ConvertTo-Json -Depth 10 -Compress}
  catch{@{id=$request.id;error=$_.Exception.Message} | ConvertTo-Json -Compress}
 }
}else{Read-Image $ImagePath $Language | ConvertTo-Json -Depth 8 -Compress}
