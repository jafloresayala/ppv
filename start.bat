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

REM ── Redis (servicio Windows nativo tiene prioridad sobre Docker) ──────────
echo Checking Redis...
sc query Redis >nul 2>&1
if %errorlevel% equ 0 (
    sc start Redis >nul 2>&1
    "%PYTHON%" -c "import socket; s=socket.create_connection(('127.0.0.1',6379),timeout=2); s.close()" >nul 2>&1
    if %errorlevel% equ 0 (
        echo [OK] Redis Windows service running on localhost:6379
        goto skip_redis
    )
)

REM Redis nativo no disponible — intentar con Docker
docker info >nul 2>&1
if %errorlevel% neq 0 goto no_redis

docker start ppv-redis >nul 2>&1
if %errorlevel% neq 0 (
    docker run -d --name ppv-redis -p 6379:6379 --restart unless-stopped redis:7-alpine >nul 2>&1
)
if %errorlevel% equ 0 (
    echo [OK] Redis Docker container running on localhost:6379
    goto skip_redis
)

:no_redis
echo [WARN] Redis no disponible — usando fallback en memoria.
:skip_redis

REM ── FastAPI backend (PPV) ─────────────────────────────────────────────────
echo [INFO] Starting PPV backend on port 8080...
start "PPV Backend" cmd /k "cd /d "%ROOT%backend" && %PYTHON% -m uvicorn main:app --host 0.0.0.0 --port 8080 --reload"

REM ── Price Calculator backend (busca en varias ubicaciones conocidas) ─────────
set PRICECALC_DIR=%ROOT%conexion_internalquery
if not exist "%PRICECALC_DIR%\app.py" (
    for %%P in ("%ROOT%..\conexion_internalquery") do set PRICECALC_DIR=%%~fP
)
if not exist "%PRICECALC_DIR%\app.py" (
    set PRICECALC_DIR=F:\api_combined_search\api_combined_search
)
if not exist "%PRICECALC_DIR%\app.py" (
    for %%P in ("%ROOT%..\api_combined_search\api_combined_search") do set PRICECALC_DIR=%%~fP
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
REM Liberar puerto 5173 si hay una instancia vieja de Vite
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":5173 " 2^>nul') do (
    taskkill /PID %%P /F >nul 2>&1
)

timeout /t 2 /nobreak >nul
start http://localhost:5173

REM Start Vite dev server (--host exposes Network URL for LAN sharing)
cd /d "%ROOT%frontend"
npm run dev -- --host
