import numpy as np
import tifffile

a = tifffile.imread(
    r"C:\Users\gavan\AppData\Local\Temp\claude\c--dev-BoatApp\e5e138c1-e107-426b-a02a-2b28edf4a63b\scratchpad\test.tif"
)
print("shape", a.shape, a.dtype)
print("min", np.nanmin(a), "max", np.nanmax(a))
w = a[a < 0]
print("water px:", w.size, "median depth:", float(np.median(-w)) if w.size else None)
