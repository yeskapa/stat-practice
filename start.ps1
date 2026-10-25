$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $projectRoot

python -c "import fastapi, uvicorn" 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Installing the small local runtime..."
    python -m pip install -r requirements.txt
    if ($LASTEXITCODE -ne 0) { throw "Dependency installation failed." }
}

python scripts/release_check.py --allow-demo-only
if ($LASTEXITCODE -ne 0) { throw "Readiness checks failed. The mock was not started." }

$server = Start-Process -FilePath "python" `
    -ArgumentList @("-m", "uvicorn", "app:app", "--host", "127.0.0.1", "--port", "8000") `
    -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru

try {
    $ready = $false
    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:8000/api/tests" -UseBasicParsing -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { }
    }
    if (-not $ready) { throw "The local server did not become ready." }

    $launchVersion = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    Start-Process "http://127.0.0.1:8000/?launch=$launchVersion"
    Write-Host ""
    Write-Host "STAT mock is running. Choose a paper from the available tests."
    Write-Host "Keep this window open. Press Enter after you have finished using the app."
    [void](Read-Host)
} finally {
    if (-not $server.HasExited) { Stop-Process -Id $server.Id }
}
