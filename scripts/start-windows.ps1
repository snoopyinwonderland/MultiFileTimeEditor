[CmdletBinding()]
param(
  [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeRoot = Join-Path $projectRoot '.runtime'
$nodeExtractRoot = Join-Path $runtimeRoot 'node'
$parentNodeExtractRoot = Join-Path (Split-Path -Parent $projectRoot) '.runtime\node'
$sharedNodeExtractRoots = @(
  (Join-Path (Split-Path -Parent $projectRoot) 'Screenshot Automation\.runtime\node'),
  (Join-Path (Split-Path -Parent $projectRoot) 'Screenshop Automation\.runtime\node')
)
$logRoot = Join-Path $runtimeRoot 'logs'
$serverLog = Join-Path $logRoot 'multiple-file-date-time-editor-latest.log'
$desktopLog = Join-Path $logRoot 'multiple-file-date-time-editor-desktop-latest.log'
$appUrl = 'http://127.0.0.1:3102'

function Get-NodePath {
  $systemNode = Get-Command 'node.exe' -CommandType Application -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($systemNode) {
    $major = [int]((& $systemNode.Source --version).TrimStart('v').Split('.')[0])
    if ($major -ge 20) { return $systemNode.Source }
  }

  $localNode = Get-ChildItem -LiteralPath $nodeExtractRoot -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($localNode) { return $localNode.FullName }

  $parentNode = Get-ChildItem -LiteralPath $parentNodeExtractRoot -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($parentNode) { return $parentNode.FullName }

  foreach ($sharedNodeExtractRoot in $sharedNodeExtractRoots) {
    $sharedNode = Get-ChildItem -LiteralPath $sharedNodeExtractRoot -Filter 'node.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($sharedNode) { return $sharedNode.FullName }
  }

  throw 'Node.js 20 이상이 필요합니다. Node.js LTS를 설치한 뒤 다시 실행해 주세요.'
}

try {
  Set-Location -LiteralPath $projectRoot
  New-Item -ItemType Directory -Path $logRoot -Force | Out-Null
  $nodePath = Get-NodePath
  $nodeBin = Split-Path -Parent $nodePath

  if (
    -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\express\package.json')) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron\package.json')) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ffmpeg-static\package.json')) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\vite\package.json')) -or
    -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\@vitejs\plugin-react\package.json'))
  ) {
    Write-Host '필요한 라이브러리를 설치합니다. 최초 실행에는 시간이 걸릴 수 있습니다.'
    $npmPath = Join-Path $nodeBin 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npmPath)) { throw 'npm.cmd를 찾지 못했습니다.' }
    & $npmPath install
    if ($LASTEXITCODE -ne 0) { throw "npm install이 종료 코드 $LASTEXITCODE 로 실패했습니다." }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ffmpeg-static\ffmpeg.exe'))) {
    Write-Host 'TS 영상 재생에 필요한 FFmpeg 실행 파일을 설치합니다.'
    & (Join-Path $nodeBin 'npm.cmd') rebuild ffmpeg-static
    if ($LASTEXITCODE -ne 0) { throw "FFmpeg 설치가 종료 코드 $LASTEXITCODE 로 실패했습니다." }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\ffmpeg-static\ffmpeg.exe'))) {
      throw 'FFmpeg 실행 파일을 설치하지 못했습니다. 네트워크 연결과 npm 설치 로그를 확인해 주세요.'
    }
  }
  if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) {
    Write-Host '실행 화면을 빌드합니다.'
    & (Join-Path $nodeBin 'npm.cmd') run build
    if ($LASTEXITCODE -ne 0) { throw "화면 빌드가 종료 코드 $LASTEXITCODE 로 실패했습니다." }
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'dist\index.html'))) {
      throw '실행 화면을 빌드하지 못했습니다. npm run build를 다시 실행해 주세요.'
    }
  }
  $electronPath = Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'
  $electronCli = Join-Path $projectRoot 'node_modules\electron\cli.js'
  if (-not (Test-Path -LiteralPath $electronPath)) {
    $electronInstall = Join-Path $projectRoot 'node_modules\electron\install.js'
    if (Test-Path -LiteralPath $electronInstall) {
      Write-Host 'Electron 데스크톱 실행 파일을 받습니다. 최초 실행에는 시간이 걸릴 수 있습니다.'
      $env:ELECTRON_CACHE = Join-Path $runtimeRoot 'electron-cache'
      & $nodePath $electronInstall
      if ($LASTEXITCODE -ne 0) { throw "Electron 설치가 종료 코드 $LASTEXITCODE 로 실패했습니다." }
    }
  }
  if (-not (Test-Path -LiteralPath $electronPath)) {
    throw 'Electron 데스크톱 실행 파일이 없습니다. npm install을 다시 실행해 주세요.'
  }
  if (-not (Test-Path -LiteralPath $electronCli)) {
    throw 'Electron 실행 스크립트가 없습니다. npm install을 다시 실행해 주세요.'
  }

  if ($CheckOnly) {
    Write-Host 'Windows 실행 준비가 완료되었습니다.' -ForegroundColor Green
    exit 0
  }

  Write-Host 'Multiple File Date Time Editor 데스크톱 창을 시작합니다.'
  Write-Host '전용 창이나 이 콘솔 창을 닫으면 프로그램도 종료됩니다.' -ForegroundColor Yellow
  Write-Host "문제가 생기면 다음 로그를 확인할 수 있습니다: $desktopLog"
  $env:LOCAL_APP_NODE_PATH = $nodePath
  $env:LOCAL_APP_URL = $appUrl
  $env:LOCAL_APP_LOG = $serverLog
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & $nodePath $electronCli (Join-Path $projectRoot 'electron\main.cjs') 2>&1 |
      ForEach-Object { $_.ToString() } |
      Tee-Object -FilePath $desktopLog -Append
    $desktopExit = $LASTEXITCODE
  }
  finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($desktopExit -ne 0) {
    throw "데스크톱 창이 종료 코드 $desktopExit 로 끝났습니다. 로그: $desktopLog"
  }
  exit 0
}
catch {
  Write-Host "`n오류: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
