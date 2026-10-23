# Copyright (c) 2026 Christiaan (chris@boreddev.nl)
# BoredOS doomgeneric Makefile

CC = x86_64-boredos-gcc

BOREDOS_SDK ?= $(abspath ../../build/sdk)
SDK_PATH = $(BOREDOS_SDK)

DESTDIR ?= $(abspath build/dist)

CFLAGS  = -Wall -Wextra -std=gnu11 -O2 -fno-stack-protector \
          -fno-stack-check -m64 -march=x86-64 \
          -I$(SDK_PATH)/include -Isrc -DNORMALUNIX -D_DEFAULT_SOURCE \
          -DDOOMGENERIC_RESX=1280 -DDOOMGENERIC_RESY=800

LDFLAGS = -Wl,-z,max-page-size=0x1000 -Wl,-dynamic-linker,/usr/lib/ld.so -Wl,-rpath,/usr/lib:/lib \
          -L$(SDK_PATH)/lib -lm

# Core Doom source files + Platform port file
SOURCES = $(wildcard src/*.c)
OBJECTS = $(SOURCES:src/%.c=obj/%.o)
BINARY = doom

all: bootstrap-sdk $(BINARY)

# Autonomic SDK Bootstrapper
.PHONY: bootstrap-sdk
bootstrap-sdk:
	@if [ ! -f "$(SDK_PATH)/include/novaproto.h" ]; then \
		if [ -d "../nova" ]; then \
			echo "Exporting Nova SDK components..."; \
			$(MAKE) -C ../nova BOREDOS_SDK=$(SDK_PATH) export-sdk; \
		fi \
	fi

# Compile C source files
obj/%.o: src/%.c | bootstrap-sdk
	@mkdir -p obj
	$(CC) $(CFLAGS) -c $< -o $@

# Link the userland executable
$(BINARY): $(OBJECTS)
	$(CC) $(OBJECTS) -lnovaproto $(LDFLAGS) -o $@

install: all
	mkdir -p $(DESTDIR)/bin
	cp $(BINARY) $(DESTDIR)/bin/
	mkdir -p $(DESTDIR)/Library/AppData/org.boredos.doomgeneric
	@if [ -f freedoom1.wad ]; then \
		cp freedoom1.wad $(DESTDIR)/Library/AppData/org.boredos.doomgeneric/doom1.wad; \
	fi
	@if [ -f pack/assets/doom.png ]; then \
		cp pack/assets/doom.png $(DESTDIR)/Library/AppData/org.boredos.doomgeneric/doomgeneric.png; \
	fi
	@if [ -d pack/apps ]; then \
		cp -a pack/apps/*.desktop $(DESTDIR)/Library/AppData/org.boredos.doomgeneric/; \
	fi


.PHONY: bup
bup: all
	rm -rf build/package
	mkdir -p build/package/bin build/package/assets build/package/usr/share/applications
	cp $(BINARY) build/package/bin/
	@if [ -f freedoom1.wad ]; then cp freedoom1.wad build/package/assets/freedoom1.wad; fi
	# Include any packaged assets (icons) from pack/assets
	if [ -f pack/assets/doom.png ]; then \
		cp pack/assets/doom.png build/package/assets/doomgeneric.png; \
	fi
	# Include any application desktop entries from pack/apps (if present)
	if [ -d pack/apps ]; then \
		cp -a pack/apps/*.desktop build/package/usr/share/applications/; \
	fi
	# Use pack/MANIFEST.toml if provided, otherwise generate a minimal manifest
	if [ -f pack/MANIFEST.toml ]; then \
		cp pack/MANIFEST.toml build/package/MANIFEST.toml; \
	else \
		@echo 'name = "doomgeneric"' > build/package/MANIFEST.toml; \
		@echo 'version = "1.0.0"' >> build/package/MANIFEST.toml; \
		@echo '[install]' >> build/package/MANIFEST.toml; \
		@echo 'bin = "/bin"' >> build/package/MANIFEST.toml; \
		@echo 'assets = "/Library/AppData/org.boredos.doomgeneric"' >> build/package/MANIFEST.toml; \
	fi
	x86_64-boredos-strip --strip-unneeded build/package/bin/* 2>/dev/null || true
	tar -cf build/doomgeneric.tar -C build/package MANIFEST.toml bin assets usr
	lz4 -f build/doomgeneric.tar build/doomgeneric.bup
	rm -f build/doomgeneric.tar
	rm -rf build/package

clean:
	rm -rf obj $(BINARY) build
