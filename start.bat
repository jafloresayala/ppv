@echo off
echo Starting PPV Analytics...

REM ── Docker Desktop ────────────────────────────────────────────────────────
echo Checking Docker...
docker info >nul 2>&1
if %errorlevel% equ 0 goto docker_ready

echo [INFO] Docker not running. Starting Docker Desktop...
start "" "C:\Program Files\Docker\Docker\Docker Desktop.exe"
echo [INFO] Waiting for Docker to be ready (up to 60 s)...
set /a _tries=0

:wait_docker
timeout /t 3 /nobreak >nul
set /a _tries+=1
docker info >nul 2>&1
if %errorlevel% equ 0 goto docker_ready
if %_tries% lss 20 goto wait_docker
echo [WARN] Docker did not start in time. Redis will be skipped.
goto skip_redis

:docker_ready
echo [OK] Docker is ready.

REM ── Redis cache ───────────────────────────────────────────────────────────
echo Checking Redis...
docker start ppv-redis >nul 2>&1 || docker run -d --name ppv-redis -p 6379:6379 --restart unless-stopped redis:7-alpine >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARN] Redis not available. App will use in-memory fallback.
) else (
    echo [OK] Redis running on localhost:6379
)
:skip_redis

REM ── FastAPI backend (PPV) ─────────────────────────────────────────────────
start "PPV Backend" cmd /k "cd /d "%~dp0backend" && uvicorn main:app --host 0.0.0.0 --port 8080 --reload"

REM ── Price Calculator backend (conexion_internalquery) ─────────────────────
set PRICECALC_DIR=C:\Users\K90016277\OneDrive - Kimball Electronics\Documentos\Proyectos\conexion_internalquery
if exist "%PRICECALC_DIR%\app.py" (
    echo [INFO] Starting Price Calculator backend on port 8081...
    start "Price Calculator" cmd /k "cd /d "%PRICECALC_DIR%" && "%PRICECALC_DIR%\env\Scripts\uvicorn.exe" app:app --host 0.0.0.0 --port 8081 --reload"
    echo [OK] Price Calculator backend started.
) else (
    echo [WARN] Price Calculator not found at %PRICECALC_DIR% — skipping.
)

REM Wait a bit then open browser
timeout /t 3 /noisy >nul
start http://localhost:5173

REM Start Vite dev server
cd /d "%~dp0frontend"
npm run dev
