' Starts the reels web studio at logon without a console window.
' Put a filled copy into the Startup folder (shell:startup).
CreateObject("WScript.Shell").Run """__NODE__"" ""__ROOT__\web\server.mjs""", 0, False
