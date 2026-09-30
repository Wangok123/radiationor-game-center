[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Directory)
$ErrorActionPreference = 'Stop'
foreach ($file in Get-ChildItem -LiteralPath $Directory -Filter '*.md' -File) {
    $raw = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8
    $match = [regex]::Match($raw, '(?s)^---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|$)(.*)$')
    if (-not $match.Success) { throw "Missing front matter: $($file.Name)" }
    foreach ($field in @('slug', 'title', 'date', 'updated', 'category', 'reading_time', 'tags', 'summary')) {
        if ($match.Groups[1].Value -notmatch "(?m)^${field}:\s*\S.+$") { throw "Missing $field in $($file.Name)" }
    }
    $body = $match.Groups[2].Value
    if ([regex]::Matches($body, '(?m)^##\s+').Count -lt 3) { throw "Article lost its section structure: $($file.Name)" }
    if ($body -match '\[\[|\bLAT\b|[A-Z]:\\|Project_Experience|\.obsidian|obsidian://|Unity引擎|(?m)^#{1,3}.*(?:面试|闪卡|实验)|本页(?:保持|应保持)|(?:TODO|TBD|待补充)') {
        throw "Private, unresolved or unfinished content: $($file.Name)"
    }
    $inCode = $false; $headingCount = 0; $tableColumns = 0; $previousHeading = $false
    foreach ($line in ($body -split '\r?\n')) {
        if ($line -match '^\s*```') { $inCode = -not $inCode; $previousHeading = $false; continue }
        if ($inCode) { continue }
        if ($line -match '^#\s+') { $headingCount++ }
        if ($line -match '^#{2,3}\s+') {
            if ($previousHeading) { throw "Empty section: $($file.Name)" }
            $previousHeading = $true
        } elseif ($line.Trim()) { $previousHeading = $false }
        if ($line -match '^\|') {
            $columns = $line.Trim().Trim('|').Split('|').Count
            if ($tableColumns -and $columns -ne $tableColumns) { throw "Table column mismatch: $($file.Name)" }
            $tableColumns = $columns
        } else { $tableColumns = 0 }
    }
    if ($inCode -or $headingCount -ne 1 -or $previousHeading) { throw "Invalid headings or fences: $($file.Name)" }
}
Write-Host 'Validated article metadata, privacy markers, sections, code fences and tables.'
