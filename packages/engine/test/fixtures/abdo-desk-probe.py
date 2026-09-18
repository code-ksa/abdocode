#!/usr/bin/env python3
# ب2 — لوحُ الحقيقة لقناة لينكس (نظيرُ probe WinForms): نافذةُ GTK3 بحقلٍ وزرّ «Save» يكتب نصَّ الحقل إلى الملفّ المعطى.
# يُشغَّل بـGDK_BACKEND=x11 كي يراه xdotool تحت WSLg، وعلى حافلة الجلسة نفسِها التي يقرأ منها AT-SPI.
import sys
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk

out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/abdo-desk-probe.txt"
win = Gtk.Window(title="Abdo Desk Probe")
win.set_default_size(420, 160)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=8, margin=12)
label = Gtk.Label(label="Field")
entry = Gtk.Entry()
entry.set_name("field")
entry.get_accessible().set_name("Field")
button = Gtk.Button(label="Save")
button.get_accessible().set_name("Save")
def save(_b):
    with open(out, "w", encoding="utf-8") as f:
        f.write(entry.get_text())
button.connect("clicked", save)
box.pack_start(label, False, False, 0)
box.pack_start(entry, False, False, 0)
box.pack_start(button, False, False, 0)
win.add(box)
win.connect("destroy", Gtk.main_quit)
win.show_all()
Gtk.main()
