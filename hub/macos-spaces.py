#!/usr/bin/env python3
# Reports, for each normal Google Chrome window, which macOS Space (virtual
# desktop) it sits on, plus the active Space. The BrowserLink hub uses this to
# tell which window is on the desktop the user is currently looking at.
#
# Bounds/titles come from the public CGWindowList; the Space id and the
# per-display desktop order come from the private CoreGraphics "CGS" API (the
# same one yabai reads). Every failure degrades to null/empty so a non-mac
# host, a missing dependency, or a future OS change can never break the hub.
import json


def main():
    import Quartz, ctypes, ctypes.util

    opt = Quartz.kCGWindowListOptionAll | Quartz.kCGWindowListExcludeDesktopElements
    info = Quartz.CGWindowListCopyWindowInfo(opt, Quartz.kCGNullWindowID) or []
    wins = []
    for w in info:
        if w.get('kCGWindowOwnerName') != 'Google Chrome':
            continue
        if w.get('kCGWindowLayer', 0) != 0:          # 0 = normal level; skip panels/tooltips
            continue
        b = w.get('kCGWindowBounds') or {}
        wd = int(b.get('Width', 0)); ht = int(b.get('Height', 0))
        if wd < 200 or ht < 200:                     # skip tiny helper windows
            continue
        wins.append({
            'cgid': int(w.get('kCGWindowNumber', 0)),
            'bounds': [int(b.get('X', 0)), int(b.get('Y', 0)), wd, ht],
            'title': w.get('kCGWindowName') or '',
        })

    active = None
    space_meta = {}
    try:
        import objc
        from Foundation import NSArray
        cg = ctypes.cdll.LoadLibrary(ctypes.util.find_library('CoreGraphics'))
        cg._CGSDefaultConnection.restype = ctypes.c_int
        conn = cg._CGSDefaultConnection()

        try:
            cg.CGSGetActiveSpace.restype = ctypes.c_uint64
            cg.CGSGetActiveSpace.argtypes = [ctypes.c_int]
            active = int(cg.CGSGetActiveSpace(conn))
        except Exception:
            active = None

        # Desktop ordinal (counting only normal desktops, like Mission Control)
        # and the current space, per display.
        try:
            cg.CGSCopyManagedDisplaySpaces.restype = ctypes.c_void_p
            cg.CGSCopyManagedDisplaySpaces.argtypes = [ctypes.c_int]
            dptr = cg.CGSCopyManagedDisplaySpaces(conn)
            displays = objc.objc_object(c_void_p=ctypes.c_void_p(dptr)) if dptr else []
            for di, d in enumerate(displays):
                cur = (d.get('Current Space') or {}).get('ManagedSpaceID')
                ordinal = 0
                for sp in (d.get('Spaces') or []):
                    sid = sp.get('ManagedSpaceID')
                    if sid is None:
                        continue
                    normal = (sp.get('type') == 0)   # 0 = user desktop; 4 = fullscreen/tiled
                    if normal:
                        ordinal += 1
                    space_meta[int(sid)] = {
                        'desktop': ordinal if normal else None,
                        'display': di,
                        'current': bool(cur is not None and int(sid) == int(cur)),
                    }
        except Exception:
            pass

        # Space id for each window.
        cg.CGSCopySpacesForWindows.restype = ctypes.c_void_p
        cg.CGSCopySpacesForWindows.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_void_p]
        for wdict in wins:
            try:
                arr = NSArray.arrayWithArray_([wdict['cgid']])
                ptr = cg.CGSCopySpacesForWindows(conn, 7, objc.pyobjc_id(arr))  # 7 = all space types
                spaces = objc.objc_object(c_void_p=ctypes.c_void_p(ptr)) if ptr else None
                lst = [int(x) for x in spaces] if spaces else []
                sid = lst[0] if lst else None
            except Exception:
                sid = None
            wdict['space'] = sid
            m = space_meta.get(sid) if sid is not None else None
            if m:
                wdict['desktop'] = m['desktop']
                wdict['display'] = m['display']
                wdict['onActiveDesktop'] = m['current']
            else:
                # Space isn't in the managed per-display list (e.g. a fullscreen
                # Chrome window). We can't place it on a numbered desktop, and
                # CGSGetActiveSpace is a different id namespace, so don't guess.
                wdict['desktop'] = None
                wdict['display'] = None
                wdict['onActiveDesktop'] = False
    except Exception as e:
        for wdict in wins:
            wdict.setdefault('space', None)
            wdict.setdefault('desktop', None)
            wdict.setdefault('display', None)
            wdict.setdefault('onActiveDesktop', False)
        print(json.dumps({'activeSpace': active, 'windows': wins, 'error': str(e)}))
        return

    print(json.dumps({'activeSpace': active, 'windows': wins}))


try:
    main()
except Exception as e:
    print(json.dumps({'activeSpace': None, 'windows': [], 'error': str(e)}))
