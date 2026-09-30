[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Directory,
    [Parameter(Mandatory = $true)][string]$SiteUrl
)
$ErrorActionPreference = 'Stop'
$Directory = [IO.Path]::GetFullPath($Directory)
$sitePrefix = ([uri]$SiteUrl).AbsolutePath.TrimEnd('/') + '/'
$files = @(Get-ChildItem -LiteralPath $Directory -Recurse -Filter '*.html' -File)

function Resolve-LocalTarget([string]$Url, [string]$Parent) {
    if ($Url.StartsWith('/')) {
        if (-not $Url.StartsWith($sitePrefix)) { throw "Root link outside site prefix: $Url" }
        return [IO.Path]::GetFullPath((Join-Path $Directory $Url.Substring($sitePrefix.Length)))
    }
    [IO.Path]::GetFullPath((Join-Path $Parent $Url))
}

foreach ($file in $files) {
    $html = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8
    foreach ($required in @('<!doctype html>', '<meta name="description"', '<link rel="canonical"', 'id="main-content"')) {
        if (-not $html.Contains($required)) { throw "Missing $required in $($file.Name)" }
    }
    if ([regex]::Matches($html, '<h1\b').Count -ne 1) { throw "Expected one h1 in $($file.Name)" }
    $schema = [regex]::Match($html, '(?s)<script type="application/ld\+json">(.*?)</script>')
    $schema.Groups[1].Value | ConvertFrom-Json | Out-Null
    $ids = @{}
    foreach ($id in [regex]::Matches($html, '\bid=["'']([^"'']+)["'']')) {
        $value = $id.Groups[1].Value
        if ($ids.ContainsKey($value)) { throw "Duplicate id $value in $($file.Name)" }
        $ids[$value] = $true
    }
    foreach ($match in [regex]::Matches($html, '\b(?:href|src)=["'']([^"'']+)["'']')) {
        $url = [System.Net.WebUtility]::HtmlDecode($match.Groups[1].Value)
        if ($url -match '^(https?:|mailto:|data:|tel:)') { continue }
        if ($url -match '^[a-z]+:') { throw "Unsupported link scheme: $url" }
        $parts = $url -split '#', 2
        $path = ($parts[0] -split '\?', 2)[0]
        $target = if ($path) { Resolve-LocalTarget $path $file.DirectoryName } else { $file.FullName }
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { throw "Broken local link $url in $($file.Name)" }
        if ($parts.Count -gt 1 -and $parts[1]) {
            $fragment = [uri]::UnescapeDataString($parts[1])
            $targetHtml = Get-Content -LiteralPath $target -Raw -Encoding utf8
            $targetIds = @([regex]::Matches($targetHtml, '\bid=["'']([^"'']+)["'']') | ForEach-Object { $_.Groups[1].Value })
            if ($fragment -notin $targetIds) { throw "Missing anchor $url in $($file.Name)" }
        }
    }
}
foreach ($css in (Get-ChildItem -LiteralPath $Directory -Filter '*.css' -File)) {
    foreach ($match in [regex]::Matches((Get-Content -LiteralPath $css.FullName -Raw), 'url\(["'']?([^"''\)]+)["'']?\)')) {
        $path = $match.Groups[1].Value
        if ($path -match '^https?:') { throw "External stylesheet asset: $path" }
        if (-not (Test-Path -LiteralPath (Join-Path $css.DirectoryName $path))) { throw "Missing stylesheet asset: $path" }
    }
}
[xml]$sitemap = Get-Content -LiteralPath (Join-Path $Directory 'sitemap.xml') -Raw -Encoding utf8
[xml]$feed = Get-Content -LiteralPath (Join-Path $Directory 'feed.xml') -Raw -Encoding utf8
$articleCount = @($files | Where-Object DirectoryName -eq (Join-Path $Directory 'notes')).Count
if (@($feed.rss.channel.item).Count -ne $articleCount) { throw 'RSS article count mismatch' }
if (@($sitemap.urlset.url).Count -ne $files.Count - 1) { throw 'Sitemap page count mismatch' }
if (Test-Path -LiteralPath (Join-Path $Directory 'portfolio.html')) { throw 'Removed page still exists' }
Write-Host "Validated $($files.Count) pages, local links, anchors, assets, JSON-LD, RSS and sitemap."
