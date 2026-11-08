"""Stand-in for the PyQt5 names Flow-Py imports; the terminal run never uses the GUI."""
def pyqtSlot(*a, **k):
    return lambda f: f
def pyqtSignal(*a, **k):
    return None
class QCoreApplication: pass
class QThread:
    def __init__(self, *a, **k): pass
