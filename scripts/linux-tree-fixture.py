"""Synthetic GTK controls for the native capture privacy regression check."""
import gi
gi.require_version('Gtk', '3.0')
from gi.repository import Gtk, GLib

GLib.set_prgname('synthetic-gtk')
window = Gtk.Window(title='Synthetic GTK fixture')
window.set_default_size(420, 360)
box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL)
window.add(box)
box.pack_start(Gtk.Label(label='PUBLIC_LABEL_SENTINEL'), True, True, 0)
for value, visible in [('EDITABLE_VALUE_SENTINEL', True), ('PASSWORD_VALUE_SENTINEL', False)]:
    entry = Gtk.Entry()
    entry.set_text(value)
    entry.set_visibility(visible)
    entry.get_accessible().set_name(value + '_ACCESSIBLE_NAME')
    box.pack_start(entry, True, True, 0)
combo = Gtk.ComboBoxText.new_with_entry()
combo.append_text('COMBO_EDITABLE_SENTINEL')
combo.set_active(0)
box.pack_start(combo, True, True, 0)
box.pack_start(Gtk.Button(label='PUBLIC_BUTTON_SENTINEL'), True, True, 0)
window.connect('destroy', Gtk.main_quit)
window.show_all()
Gtk.main()
