@echo off
echo Building PPV Analytics for production...

REM Build frontend
cd /d "%~dp0frontend"
call npm run build
echo Frontend built in frontend/dist/

REM Start production backend (serves built frontend via static files or separate port)
echo.
echo To run in production:
echo   Backend:  cd backend ^&^& uvicorn main:app --host 0.0.0.0 --port 8000
echo   Frontend: cd frontend ^&^& npm run preview
