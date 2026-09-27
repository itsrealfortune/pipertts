{
	"targets": [
		{
			"target_name": "espeak_bridge",
			"sources": ["src/native/espeak-bridge/espeak_bridge.c"],
			"libraries": ["-lespeak-ng"],
			"cflags": ["-O2", "-Wall"],
			"conditions": [
				[
					'OS=="linux"',
					{
						"libraries": ["-lespeak-ng", "-ldl"],
					},
				],
				[
					'OS=="win"',
					{
						"libraries": ["-lespeak-ng"],
						"include_dirs": ["C:/espeak-ng/include"],
						"library_dirs": ["C:/espeak-ng/lib"],
					},
				],
				[
					'OS=="mac"',
					{
						"include_dirs": ["/opt/homebrew/include", "/usr/local/include"],
						"library_dirs": ["/opt/homebrew/lib", "/usr/local/lib"],
					},
				],
			],
		}
	]
}
