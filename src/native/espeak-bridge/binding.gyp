{
	"targets": [
		{
			"target_name": "espeak_bridge",
			"sources": ["espeak_bridge.c"],
			"libraries": ["-lespeak-ng"],
			"cflags": ["-O2", "-Wall"]
		}
	]
}
