# 重新生成 site/vendor 下的联机依赖。
#
# 只有升级 Trystero 时才需要跑一次。产物（vendor/*.js）是提交进仓库的，
# 因此构建站点、部署到 GitHub Pages 都不需要 Node。
#
#   powershell -ExecutionPolicy Bypass -File scripts/build-game-vendor.ps1
#
# 依赖：Node.js 18+ 与网络。
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$workDir = Join-Path $repoRoot '.tools/vendor'
$outDir = Join-Path $repoRoot 'site/vendor'

# 固定版本，避免每次生成出不同的产物
$trysteroVersion = '0.26.0'
$esbuildVersion = '0.25.10'
$strategies = @('mqtt', 'nostr', 'torrent')

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw '找不到 node，请先安装 Node.js 18+（只在这条命令里需要它）。'
}

New-Item -ItemType Directory -Force -Path $workDir | Out-Null
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$packageJson = Join-Path $workDir 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) {
    Set-Content -LiteralPath $packageJson -Encoding utf8 -Value '{"name":"game-vendor","private":true,"type":"module"}'
}

Write-Host "[1/3] 安装打包依赖到 .tools/vendor ..."
$npm = if (Get-Command npm.cmd -ErrorAction SilentlyContinue) { 'npm.cmd' } else { 'npm' }
Push-Location $workDir
try {
    $packages = @((Join-Path $workDir 'node_modules/esbuild'))
    $packages += $strategies | ForEach-Object { Join-Path $workDir "node_modules/@trystero-p2p/$_" }
    if ($packages | Where-Object { -not (Test-Path -LiteralPath $_) }) {
        $specs = @("esbuild@$esbuildVersion") + ($strategies | ForEach-Object { "@trystero-p2p/$_@$trysteroVersion" })
        & $npm install --silent --no-audit --no-fund @specs
        if ($LASTEXITCODE -ne 0) { throw 'npm install 失败' }
    }
} finally {
    Pop-Location
}

Write-Host "[2/3] 用 esbuild 打包三种信令策略 ..."
$esbuild = Join-Path $workDir 'node_modules/esbuild/bin/esbuild'
if (-not (Test-Path -LiteralPath $esbuild)) { throw '找不到 esbuild 可执行文件' }

foreach ($name in $strategies) {
    $entry = Join-Path $workDir "node_modules/@trystero-p2p/$name/dist/index.mjs"
    $outFile = Join-Path $outDir "$name.js"
    & node $esbuild $entry --bundle --format=esm --minify --platform=browser --target=es2020 --legal-comments=eof --log-level=warning --outfile=$outFile
    if ($LASTEXITCODE -ne 0) { throw "打包 $name 失败" }
    $size = [Math]::Round((Get-Item -LiteralPath $outFile).Length / 1KB, 1)
    Write-Host ("    {0,-8} {1,7} KB" -f "$name.js", $size)
}

Write-Host "[3/3] 完成。产物在 site/vendor/，记得把改动一起提交。"
