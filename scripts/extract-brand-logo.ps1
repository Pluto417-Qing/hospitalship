param(
  [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$designRed = [System.Drawing.Color]::FromArgb(204, 65, 26)
$assetDirectory = Join-Path $ProjectRoot "miniprogram\images\brand"
[System.IO.Directory]::CreateDirectory($assetDirectory) | Out-Null

function Export-WhiteLogoCrop {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][System.Drawing.Rectangle]$Crop
  )

  $sourceBitmap = [System.Drawing.Bitmap]::FromFile($Source)
  try {
    if (
      $Crop.X -lt 0 -or
      $Crop.Y -lt 0 -or
      $Crop.Right -gt $sourceBitmap.Width -or
      $Crop.Bottom -gt $sourceBitmap.Height
    ) {
      throw "Logo crop is outside the source image: $Source"
    }

    $outputBitmap = New-Object System.Drawing.Bitmap(
      $Crop.Width,
      $Crop.Height,
      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb
    )
    try {
      for ($targetY = 0; $targetY -lt $Crop.Height; $targetY += 1) {
        for ($targetX = 0; $targetX -lt $Crop.Width; $targetX += 1) {
          $pixel = $sourceBitmap.GetPixel($Crop.X + $targetX, $Crop.Y + $targetY)

          # The approved design places white calligraphy on a flat #CC411A field.
          # Recover the original antialias coverage from the green/blue channels,
          # then keep the exact glyph silhouette as a transparent white asset.
          $greenCoverage = ([double]$pixel.G - $designRed.G) / (255 - $designRed.G)
          $blueCoverage = ([double]$pixel.B - $designRed.B) / (255 - $designRed.B)
          $coverage = [Math]::Max(
            [double]0,
            [Math]::Min([double]1, ($greenCoverage + $blueCoverage) / 2)
          )

          if ($coverage -lt 0.025) {
            $alpha = 0
          } elseif ($coverage -gt 0.985) {
            $alpha = 255
          } else {
            $alpha = [int][Math]::Round($coverage * 255)
          }

          $outputBitmap.SetPixel(
            $targetX,
            $targetY,
            [System.Drawing.Color]::FromArgb($alpha, 255, 255, 255)
          )
        }
      }

      $outputBitmap.Save($Destination, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally {
      $outputBitmap.Dispose()
    }
  } finally {
    $sourceBitmap.Dispose()
  }
}

$verticalSource = Join-Path $ProjectRoot "ui\0.png"
$horizontalSource = Join-Path $ProjectRoot "ui\2.png"

Export-WhiteLogoCrop `
  -Source $verticalSource `
  -Destination (Join-Path $assetDirectory "china-hospital-ship-vertical.png") `
  -Crop (New-Object System.Drawing.Rectangle(226, 300, 123, 650))

Export-WhiteLogoCrop `
  -Source $horizontalSource `
  -Destination (Join-Path $assetDirectory "china-hospital-ship-horizontal.png") `
  -Crop (New-Object System.Drawing.Rectangle(132, 956, 257, 62))

Export-WhiteLogoCrop `
  -Source $horizontalSource `
  -Destination (Join-Path $assetDirectory "china-hospital-ship-horizontal-bracketed.png") `
  -Crop (New-Object System.Drawing.Rectangle(92, 956, 340, 62))

Write-Host "Extracted three approved calligraphy assets into $assetDirectory"
