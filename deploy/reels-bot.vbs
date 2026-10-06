' Starts reels-bot at logon without a console window.
' Put a filled copy into the Startup folder (shell:startup).
CreateObject("WScript.Shell").Run """__NODE__"" ""__ROOT__\bot\run.mjs""", 0, False
