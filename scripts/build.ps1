[CmdletBinding()]
param(
    [string]$SourceDir,
    [string]$OutputDir
)

$ErrorActionPreference = 'Stop'
if (-not $SourceDir) { $SourceDir = Join-Path $PSScriptRoot '..\src' }
if (-not $OutputDir) { $OutputDir = Join-Path $PSScriptRoot '..\dist' }
$SourceDir = [IO.Path]::GetFullPath($SourceDir)
$OutputDir = [IO.Path]::GetFullPath($OutputDir)

function Get-ContentItems {
    param([string]$Directory)
    Get-ChildItem -Path $Directory -Filter '*.md' -File | ForEach-Object {
        $raw = Get-Content -Path $_.FullName -Raw
        $match = [regex]::Match($raw, '(?s)^---\s*\r?\n(.*?)\r?\n---\s*\r?\n?(.*)$')
        if (-not $match.Success) { throw "Missing front matter in $($_.FullName)" }
        $item = [ordered]@{ Body = $match.Groups[2].Value.Trim(); Slug = $_.BaseName }
        foreach ($line in ($match.Groups[1].Value -split "`r?`n")) {
            if ($line -match '^([^:]+):\s*(.*)$') { $item[$matches[1].Trim()] = $matches[2].Trim() }
        }
        [pscustomobject]$item
    }
}

function HtmlEncode([string]$Value) { [System.Net.WebUtility]::HtmlEncode($Value) }
function Get-Tags([string]$Tags) { ($Tags -split '\s*\|\s*' | Where-Object { $_ }) | ForEach-Object { "<li>$(HtmlEncode $_)</li>" } }

function Get-Header([string]$Active) {
    $links = @(
        @{ Href = 'index.html'; Label = '&#39318;&#39029;'; Key = 'home' },
        @{ Href = 'portfolio.html'; Label = '&#20316;&#21697;&#38598;'; Key = 'portfolio' },
        @{ Href = 'notes.html'; Label = '&#23398;&#20064;&#31508;&#35760;'; Key = 'notes' },
        @{ Href = 'about.html'; Label = '&#20851;&#20110;&#25105;'; Key = 'about' }
    ) | ForEach-Object {
        $current = if ($_.Key -eq $Active) { ' aria-current="page"' } else { '' }
        "<a href=`"$($_.Href)`"$current>$($_.Label)</a>"
    }
    @"
<header class="site-header"><div class="wrap header-inner"><a class="brand" href="index.html" aria-label="Home"><span class="brand-mark">/U</span><span>LIN<br>UNITY PROGRAMMER</span><small>GAMEPLAY / TOOLS / SYSTEMS</small></a><nav class="nav" aria-label="Main navigation">$($links -join '')</nav></div></header>
"@
}

function New-Page([string]$Title, [string]$Active, [string]$Body) {
@"
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="LIN, a Unity programmer focused on gameplay, tools, and systems.">
  <title>$Title | LIN / Unity Programmer</title>
  <link rel="stylesheet" href="styles.css">
</head>
<body>
$(Get-Header $Active)
<main>$Body</main>
<footer class="site-footer"><div class="wrap footer-inner"><span>LIN / UNITY PROGRAMMER</span><span>Built for games, tools, and clear feedback.</span></div></footer>
</body>
</html>
"@
}

function Get-WorkCard($Work) {
@"
<article class="work-card"><img src="$(HtmlEncode $Work.image)" alt="$(HtmlEncode $Work.title) project image" loading="lazy"><div class="work-card-body"><div class="meta"><span class="badge">$(HtmlEncode $Work.type)</span><span>$(HtmlEncode $Work.date)</span></div><h3>$(HtmlEncode $Work.title)</h3><p>$(HtmlEncode $Work.summary)</p><ul class="tag-list">$(Get-Tags $Work.tech)</ul></div></article>
"@
}

function Get-NoteRow($Note) {
@"
<article class="note-row"><div class="note-date">$(HtmlEncode $Note.date)</div><div><div class="note-meta">$(HtmlEncode $Note.category) / $(HtmlEncode $Note.reading_time)</div><h3>$(HtmlEncode $Note.title)</h3><p>$(HtmlEncode $Note.excerpt)</p></div><a class="text-link" href="notes.html">READ NOTE -&gt;</a></article>
"@
}

$works = @(Get-ContentItems (Join-Path $SourceDir 'content/works') | Sort-Object date -Descending)
$notes = @(Get-ContentItems (Join-Path $SourceDir 'content/notes') | Sort-Object date -Descending)
if (Test-Path $OutputDir) { Remove-Item -LiteralPath $OutputDir -Recurse -Force }
New-Item -ItemType Directory -Path $OutputDir | Out-Null
Copy-Item -Path (Join-Path $PSScriptRoot '../public/*') -Destination $OutputDir -Recurse -Force

$featuredWorks = $works | Select-Object -First 3 | ForEach-Object { Get-WorkCard $_ }
$latestNotes = $notes | Select-Object -First 3 | ForEach-Object { Get-NoteRow $_ }
$homePage = @"
<section class="hero"><div class="hero-media"></div><div class="hero-grid"></div><div class="wrap hero-content"><div class="eyebrow">Unity programmer / building interactive systems</div><h1>&#35753;&#29609;&#27861;&#36923;&#36753;&#12289;&#24037;&#20855;&#19982;&#21453;&#39304;&#21327;&#21516;&#24037;&#20316;&#12290;</h1><p class="lede">&#19987;&#27880; Unity &#19982; C# &#24320;&#21457;&#65292;&#26500;&#24314;&#21487;&#38752;&#30340;&#28216;&#25103;&#26426;&#21046;&#12289;&#21046;&#20316;&#24037;&#20855;&#21644;&#21487;&#32500;&#25252;&#30340;&#39033;&#30446;&#26550;&#26500;&#12290;</p><div class="cta-row"><a class="button" href="portfolio.html">&#26597;&#30475;&#31934;&#36873;&#20316;&#21697;</a><a class="button secondary" href="notes.html">&#38405;&#35835;&#23398;&#20064;&#31508;&#35760;</a></div></div></section>
<section class="status-strip"><div class="wrap"><ul class="status-list"><li><span class="status-dot"></span><span>&#24403;&#21069;&#26041;&#21521;&#65306;Unity 6 / C# / URP</span></li><li><span class="status-dot"></span><span>&#20851;&#27880;&#39046;&#22495;&#65306;&#29609;&#27861;&#12289;&#24037;&#20855;&#19982;&#24615;&#33021;</span></li><li><span class="status-dot"></span><span>&#24037;&#20316;&#26041;&#24335;&#65306;&#23567;&#27493;&#39564;&#35777;&#65292;&#25345;&#32493;&#36845;&#20195;</span></li></ul></div></section>
<section class="section"><div class="wrap"><div class="section-head"><div><div class="eyebrow">Selected work</div><h2>&#31934;&#36873;&#20316;&#21697;</h2></div><a class="text-link" href="portfolio.html">&#20840;&#37096;&#20316;&#21697; -&gt;</a></div><div class="work-grid">$($featuredWorks -join '')</div></div></section>
<section class="section section-alt"><div class="wrap"><div class="section-head"><div><div class="eyebrow">Field notes</div><h2>&#26368;&#26032;&#31508;&#35760;</h2></div><a class="text-link" href="notes.html">&#20840;&#37096;&#31508;&#35760; -&gt;</a></div><div class="notes-list">$($latestNotes -join '')</div></div></section>
"@

$portfolioItems = $works | ForEach-Object {
@"
<article class="portfolio-item"><img src="$(HtmlEncode $_.image)" alt="$(HtmlEncode $_.title) project image" loading="lazy"><div class="portfolio-copy"><div class="meta"><span class="badge">$(HtmlEncode $_.type)</span><span>$(HtmlEncode $_.date)</span><span>$(HtmlEncode $_.status)</span></div><h2>$(HtmlEncode $_.title)</h2><p>$(HtmlEncode $_.summary)</p><p>$(HtmlEncode $_.Body)</p><div class="facts"><div class="fact"><strong>Platform</strong><span>$(HtmlEncode $_.platform)</span></div><div class="fact"><strong>Role</strong><span>$(HtmlEncode $_.role)</span></div><div class="fact"><strong>Focus</strong><span>$(HtmlEncode $_.highlight)</span></div></div></div></article>
"@
}

$portfolio = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">Selected work / 2025-2026</div><h1>&#20316;&#21697;&#38598;</h1><p>&#22260;&#32469;&#29609;&#27861;&#25163;&#24863;&#12289;&#31995;&#32479;&#36793;&#30028;&#21644;&#24320;&#21457;&#25928;&#29575;&#26500;&#24314;&#30340; Unity &#39033;&#30446;&#19982;&#32534;&#36753;&#22120;&#24037;&#20855;&#12290;</p></div></section><section class="section"><div class="wrap"><div class="portfolio-list">$($portfolioItems -join '')</div></div></section>
"@

$allNotes = $notes | ForEach-Object { Get-NoteRow $_ }
$notesPage = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">Working notes / Unity & C#</div><h1>&#23398;&#20064;&#31508;&#35760;</h1><p>&#35760;&#24405;&#39033;&#30446;&#20013;&#39564;&#35777;&#36807;&#30340;&#20570;&#27861;&#12289;&#26550;&#26500;&#21462;&#33293;&#19982;&#35843;&#35797;&#36807;&#31243;&#12290;&#20869;&#23481;&#30001; Markdown &#25991;&#20214;&#29983;&#25104;&#65292;&#20415;&#20110;&#25345;&#32493;&#31215;&#32047;&#12290;</p></div></section><section class="section"><div class="wrap"><div class="notes-list">$($allNotes -join '')</div></div></section>
"@

$about = @"
<section class="page-intro"><div class="wrap"><div class="eyebrow">About / Workbench</div><h1>&#20851;&#20110;&#25105;</h1><p>&#19968;&#21517;&#20851;&#27880;&#20132;&#20114;&#32454;&#33410;&#21644;&#24037;&#31243;&#21487;&#35835;&#24615;&#30340; Unity &#31243;&#24207;&#21592;&#12290;</p></div></section>
<section class="section"><div class="wrap about-layout"><div class="about-copy"><h2>&#25226;&#22797;&#26434;&#30340;&#31995;&#32479;&#20570;&#24471;&#28165;&#26224;&#12289;&#21487;&#36845;&#20195;&#12290;</h2><p>&#25105;&#20027;&#35201;&#20351;&#29992; Unity &#21644; C# &#36827;&#34892;&#29609;&#27861;&#12289;&#24037;&#20855;&#21644;&#39033;&#30446;&#26550;&#26500;&#24320;&#21457;&#12290;&#26085;&#24120;&#24037;&#20316;&#20250;&#20174;&#29609;&#23478;&#20307;&#39564;&#20986;&#21457;&#65292;&#36861;&#36394;&#27599;&#20010;&#36755;&#20837;&#12289;&#29366;&#24577;&#21644;&#21453;&#39304;&#22914;&#20309;&#36830;&#25509;&#21040;&#19968;&#36215;&#12290;</p><p>&#25105;&#21916;&#27426;&#22312;&#26089;&#26399;&#26126;&#30830;&#31995;&#32479;&#36793;&#30028;&#65292;&#29992;&#23567;&#22411;&#21487;&#27979;&#35797;&#30340;&#27169;&#22359;&#25215;&#36733;&#26680;&#24515;&#35268;&#21017;&#65292;&#20877;&#36890;&#36807;&#24037;&#20855;&#25226;&#37325;&#22797;&#24037;&#20316;&#20174;&#21046;&#20316;&#27969;&#31243;&#20013;&#31227;&#36208;&#12290;</p><h3>&#25216;&#26415;&#26632;</h3><div class="skill-board"><div><strong>GAMEPLAY</strong><span>Input, state, combat, AI behavior</span></div><div><strong>ARCHITECTURE</strong><span>C#, events, data-driven systems</span></div><div><strong>TOOLS</strong><span>UI Toolkit, custom inspectors, pipelines</span></div><div><strong>RUNTIME</strong><span>URP, profiling, loading, builds</span></div></div></div><aside class="terminal" aria-label="Developer profile"><div class="terminal-head">// developer.profile</div><div><span class="key">focus</span>: <span class="value">Unity gameplay</span></div><div><span class="key">language</span>: <span class="value">C#</span></div><div><span class="key">interests</span>: tools, systems, performance</div><div><span class="key">availability</span>: open to collaboration</div><div><span class="key">location</span>: China / remote</div></aside></div></section>
"@

$pages = [ordered]@{
    'index.html' = (New-Page 'Home' 'home' $homePage)
    'portfolio.html' = (New-Page 'Portfolio' 'portfolio' $portfolio)
    'notes.html' = (New-Page 'Notes' 'notes' $notesPage)
    'about.html' = (New-Page 'About' 'about' $about)
}
foreach ($page in $pages.GetEnumerator()) {
    Set-Content -Path (Join-Path $OutputDir $page.Key) -Value $page.Value -Encoding utf8
}

Write-Host "Built $($works.Count) works and $($notes.Count) notes to $OutputDir"
