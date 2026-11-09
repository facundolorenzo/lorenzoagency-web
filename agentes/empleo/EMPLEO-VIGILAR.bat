@echo off
cd /d "%~dp0"
echo MOTOR DE EMPLEO - busca empresas que contratan y arma los mails (dejar esta ventana abierta)
node buscador-empleo.mjs --vigilar
pause
