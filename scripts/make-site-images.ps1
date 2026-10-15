# Writes the smaller JPEG sizes of the three landing-page screenshots to site/img/ (1080 and 1600 pixels wide), for the
# srcset attributes in site/index.html. The 2160 pixel originals stay in docs/images/ and are copied by build-site.cjs.
# Windows PowerShell with System.Drawing; run it from the repository root after a screenshot changes, then commit the result:
#   powershell -ExecutionPolicy Bypass -File scripts/make-site-images.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Split-Path -Parent $PSScriptRoot
$output = Join-Path $root 'site\img'
New-Item -ItemType Directory -Force -Path $output | Out-Null
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$quality = New-Object System.Drawing.Imaging.EncoderParameters 1
$quality.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]84)
foreach ($name in 'changes-and-commit', 'file-actions', 'history') {
  $source = [System.Drawing.Image]::FromFile((Join-Path $root "docs\images\$name.jpg"))
  try {
    foreach ($width in 1080, 1600) {
      $height = [int][math]::Round($source.Height * $width / $source.Width)
      $bitmap = New-Object System.Drawing.Bitmap $width, $height
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, 0, 0, $width, $height)
        $graphics.Dispose()
        $file = Join-Path $output "$name-$width.jpg"
        $bitmap.Save($file, $codec, $quality)
        '{0}  {1}x{2}  {3:N0} KB' -f $file, $width, $height, ((Get-Item $file).Length / 1KB)
      } finally { $bitmap.Dispose() }
    }
  } finally { $source.Dispose() }
}
