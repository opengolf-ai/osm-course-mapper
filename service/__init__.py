"""Server-side hole feature detection over public-domain NAIP imagery.

The pipeline reads a corridor around a contributor's drawn playing line, asks a
class-agnostic segmentation model to enumerate every mask in it, labels those
masks with spectral rules plus the line's own geometry, and returns GeoJSON the
client renders as suggestions.

Nothing here uploads to OpenStreetMap. Every proposal reaches a human before it
becomes geometry, and the decisions — confirmed and rejected alike — persist so
they can seed a trained model later.
"""
