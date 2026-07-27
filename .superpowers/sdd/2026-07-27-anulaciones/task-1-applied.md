# Task 1: Función SQL anular_abono — Aplicada

**Migration Name:** `anular_abono`

**Date Applied:** 2026-07-27

## Verification Summary

✓ Function created: `anular_abono(p_abono_id uuid, p_usuario_id uuid) RETURNS TABLE(folio text)`

✓ Test 1: Function call returns correct folio (`REC-TESTAB01`)

✓ Test 2: Client balance updated correctly (500 → 650)

✓ Test 3: Abono flags set correctly (anulado=true, anulado_por filled, anulado_en timestamp)

✓ Test 4: Double anulation raises YA_ANULADO error as expected

✓ Test 5: Cleanup verification shows zero residue

All verification queries passed successfully. Function is idempotent-safe.
