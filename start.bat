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

echo [INFO] Starting Redis via Docker...
docker start ppv-redis >nul 2>&1
if %errorlevel% equ 0 goto redis_wait
docker run -d --name ppv-redis -p 6379:6379 --restart unless-stopped redis:7-alpine >nul 2>&1
if %errorlevel% neq 0 goto no_redis

:redis_wait
REM Esperar hasta 15s a que Redis este listo dentro del contenedor
set /a _R=0
:redis_loop
set /a _R+=1
if %_R% gtr 15 (
    echo [WARN] Redis Docker did not respond — usando fallback en memoria.
    goto skip_redis
)
"%PYTHON%" -c "import socket; s=socket.create_connection(('127.0.0.1',6379),timeout=1); s.close()" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Redis Docker container ready on localhost:6379
    goto skip_redis
)
ping -n 2 127.0.0.1 >nul 2>&1
goto redis_loop

:no_redis
REM ── Buscar redis-server.exe en PATH o rutas comunes ──────────────────────
set REDIS_EXE=
where redis-server >nul 2>&1
if %errorlevel% equ 0 for /f "delims=" %%P in ('where redis-server 2^>nul') do if not defined REDIS_EXE set REDIS_EXE=%%P
if not defined REDIS_EXE if exist "C:\Program Files\Redis\redis-server.exe"                set "REDIS_EXE=C:\Program Files\Redis\redis-server.exe"
if not defined REDIS_EXE if exist "C:\Redis\redis-server.exe"                              set "REDIS_EXE=C:\Redis\redis-server.exe"
if not defined REDIS_EXE if exist "%USERPROFILE%\scoop\apps\redis\current\redis-server.exe" set "REDIS_EXE=%USERPROFILE%\scoop\apps\redis\current\redis-server.exe"
if defined REDIS_EXE goto start_native_redis

REM ── Redis no instalado — instalar via winget ──────────────────────────────
echo [INFO] Redis no encontrado. Instalando via winget...
winget install Redis.Redis -e --source winget --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 goto redis_unavailable
REM Refrescar PATH del sistema post-instalacion
for /f "tokens=2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v PATH 2^>nul') do set "PATH=%%B;%PATH%"
where redis-server >nul 2>&1
if %errorlevel% equ 0 for /f "delims=" %%P in ('where redis-server 2^>nul') do if not defined REDIS_EXE set REDIS_EXE=%%P
if not defined REDIS_EXE if exist "C:\Program Files\Redis\redis-server.exe" set "REDIS_EXE=C:\Program Files\Redis\redis-server.exe"
if not defined REDIS_EXE goto redis_unavailable
echo [OK] Redis instalado.

:start_native_redis
echo [INFO] Iniciando redis-server: %REDIS_EXE%
start "Redis Server" /min "%REDIS_EXE%"
REM Esperar hasta 10s a que Redis este listo
set /a _R=0
:native_redis_loop
set /a _R+=1
if %_R% gtr 10 goto redis_unavailable
"%PYTHON%" -c "import socket; s=socket.create_connection(('127.0.0.1',6379),timeout=1); s.close()" >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] Redis listo en localhost:6379
    goto skip_redis
)
ping -n 2 127.0.0.1 >nul 2>&1
goto native_redis_loop

:redis_unavailable
echo [WARN] Redis no disponible — usando fallback en memoria.
:skip_redis

REM ── FastAPI backend (PPV) ─────────────────────────────────────────────────
echo.
echo [INFO] Verificando conectividad con servidor SAP (nts5102)...
ping -n 1 -w 2000 nts5102 >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] SAP server nts5102 accesible.
) else (
    echo [WARN] SAP server nts5102 NO es accesible.
    echo        Verifica que estas conectado a la VPN corporativa.
    echo        La aplicacion iniciara, pero las consultas SAP fallaran.
)
echo.
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
    if exist "%PRICECALC_DIR%\launch.bat" (
        start "Price Calculator" cmd /k "cd /d "%PRICECALC_DIR%" && call launch.bat"
    ) else if exist "%PRICECALC_DIR%\env\Scripts\uvicorn.exe" (
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
