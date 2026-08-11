param(
  [Parameter(Mandatory = $true)]
  [string]$EnvId,

  [Parameter(Mandatory = $true)]
  [string]$WeChatCli,

  [Parameter(Mandatory = $true)]
  [string]$ProjectRoot,

  [string[]]$Names = @()
)

# The DevTools CLI writes progress messages to stderr even when deployment
# succeeds. Keep those messages in the captured output and decide success from
# the explicit CLI result instead of treating stderr as a terminating error.
$ErrorActionPreference = "Continue"
$allFunctionNames = @(
  "login",
  "register",
  "getUser",
  "getNotes",
  "saveRecord",
  "moderationCenter",
  "adminContentCenter",
  "getContentCatalog",
  "getContentDetail",
  "markContentRead",
  "getYouthTimeline",
  "getAudioManifest",
  "getFullBookAccess",
  "specialTopicCenter",
  "quizCenter",
  "familyCenter",
  "memberInbox"
)
$unknownNames = @($Names | Where-Object { $_ -notin $allFunctionNames })

if ($unknownNames.Count -gt 0) {
  Write-Error ("Unknown cloud functions: " + ($unknownNames -join ", "))
  exit 1
}

$functionNames = if ($Names.Count -gt 0) {
  $Names
} else {
  $allFunctionNames
}
$maximumAttempts = 4
$retryDelaySeconds = 5

function Invoke-FunctionDeployment {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FunctionName
  )

  for ($attempt = 1; $attempt -le $maximumAttempts; $attempt += 1) {
    Write-Host "Deploying $FunctionName (attempt $attempt/$maximumAttempts)..."
    $output = @(
      & $WeChatCli cloud functions deploy `
        --e $EnvId `
        --n $FunctionName `
        --r `
        --project $ProjectRoot `
        --report_first `
        --report 2>&1 |
        ForEach-Object { "$_" }
    )
    $exitCode = $LASTEXITCODE
    $text = $output -join [Environment]::NewLine

    $output | ForEach-Object { Write-Host $_ }

    $escapedName = [regex]::Escape($FunctionName)
    $reportedSuccess =
      $text -match $escapedName -and
      $text -match "filesCount" -and
      $text -match "packSize"
    $reportedFailure =
      $text -match "fail to deploy cloudfunction" -or
      ($text -match "success" -and $text -match "false")

    if ($exitCode -eq 0 -and $reportedSuccess -and -not $reportedFailure) {
      return $true
    }

    if ($text -match "CreateFailed") {
      Write-Error (
        "Cloud function $FunctionName is in CreateFailed state. " +
        "Delete only this failed cloud function in the trusted console, " +
        "then run deployment again."
      )
      return $false
    }

    if ($attempt -lt $maximumAttempts) {
      Write-Warning (
        "Cloud function $FunctionName was not confirmed as deployed. " +
        "Waiting $retryDelaySeconds seconds before retrying."
      )
      Start-Sleep -Seconds $retryDelaySeconds
    }
  }

  Write-Error (
    "Cloud function $FunctionName was not confirmed after " +
    "$maximumAttempts attempts."
  )
  return $false
}

foreach ($functionName in $functionNames) {
  if (-not (Invoke-FunctionDeployment -FunctionName $functionName)) {
    exit 1
  }
}

Write-Host "All cloud functions were explicitly confirmed as deployed."
exit 0
