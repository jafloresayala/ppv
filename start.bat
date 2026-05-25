@echo off
setlocal
set ROOT=%~dp0
echo ============================================================
echo  PPV Analytics — Startup
echo ============================================================

REM ── Detectar ejecutable Python ────────────────────────────────────────────
set PYTHON=
where python >nul 2>&1 && set PYTHON=python
if "%PYTHON%"=="" (
    where py >nul 2>&1 && set PYTHON=py
)
if "%PYTHON%"=="" (
    echo [ERROR] Python no encontrado en PATH. Instala Python y agrega al PATH.
    pause
    exit /b 1
)
echo [OK] Usando Python: %PYTHON%
%PYTHON% --version

REM ── Python dependencies ───────────────────────────────────────────────────
echo.
echo [INFO] Instalando / verificando dependencias Python...
%PYTHON% -m pip install -r "%ROOT%backend\requirements.txt"
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] pip install fallo. Revisa los errores arriba.
    pause
    exit /b 1
)
echo [OK] Dependencias Python listas.

REM ── Node dependencies ─────────────────────────────────────────────────────
if not exist "%ROOT%frontend\node_modules" (
    echo [INFO] node_modules not found — running npm install...
    cd /d "%ROOT%frontend"
    npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. Ensure Node.js is in PATH.
        pause
        exit /b 1
    )
    echo [OK] Node dependencies installed.
) else (
    echo [OK] Node dependencies already present.
)

REM ── Docker / Redis ────────────────────────────────────────────────────────
echo Checking Docker...
docker info >nul 2>&1
if %errorlevel% equ 0 goto docker_ready

echo [INFO] Docker not running — trying to start Docker Desktop...
set DOCKER_DESKTOP=C:\Program Files\Docker\Docker\Docker Desktop.exe
if exist "%DOCKER_DESKTOP%" (
    start "" "%DOCKER_DESKTOP%"
    echo [INFO] Waiting for Docker to be ready (up to 60 s)...
    set /a _tries=0
    :wait_docker
    timeout /t 3 /nobreak >nul
    set /a _tries+=1
    docker info >nul 2>&1
    if %errorlevel% equ 0 goto docker_ready
    if %_tries% lss 20 goto wait_docker
)
echo [WARN] Docker not available. Redis will be skipped (in-memory fallback).
goto skip_redis

:docker_ready
echo [OK] Docker is ready.
echo Checking Redis...
docker start ppv-redis >nul 2>&1
if %errorlevel% neq 0 (
    docker run -d --name ppv-redis -p 6379:6379 --restart unless-stopped redis:7-alpine >nul 2>&1
)
if %errorlevel% neq 0 (
    echo [WARN] Redis not available. App will use in-memory fallback.
) else (
    echo [OK] Redis running on localhost:6379
)
:skip_redis

REM ── FastAPI backend (PPV) ─────────────────────────────────────────────────
echo [INFO] Starting PPV backend on port 8080...
start "PPV Backend" cmd /k "cd /d "%ROOT%backend" && %PYTHON% -m uvicorn main:app --host 0.0.0.0 --port 8080 --reload"

REM ── Price Calculator backend (sibling project or same repo) ───────────────
REM Busca primero como subcarpeta del repo, luego como proyecto hermano
set PRICECALC_DIR=%ROOT%conexion_internalquery
if not exist "%PRICECALC_DIR%\app.py" (
    for %%P in ("%ROOT%..\conexion_internalquery") do set PRICECALC_DIR=%%~fP
)
if exist "%PRICECALC_DIR%\app.py" (
    echo [INFO] Starting Price Calculator backend on port 8081...
    if exist "%PRICECALC_DIR%\env\Scripts\uvicorn.exe" (
        start "Price Calculator" cmd /k "cd /d "%PRICECALC_DIR%" && "%PRICECALC_DIR%\env\Scripts\uvicorn.exe" app:app --host 0.0.0.0 --port 8081 --reload"
    ) else (
        start "Price Calculator" cmd /k "cd /d "%PRICECALC_DIR%" && %PYTHON% -m uvicorn app:app --host 0.0.0.0 --port 8081 --reload"
    )
    echo [OK] Price Calculator backend started.
) else (
    echo [WARN] Price Calculator not found — skipping port 8081.
)

REM ── Frontend ──────────────────────────────────────────────────────────────
timeout /t 3 /nobreak >nul
start http://localhost:5173

REM Start Vite dev server (--host exposes Network URL for LAN sharing)
cd /d "%ROOT%frontend"
npm run dev -- --host
