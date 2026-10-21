<script lang="ts">
  import {getCurrencyOption} from "@lib/currency"

  export let code
</script>

<!-- beamhop: no-payments (no sats symbol; unknown codes show the code) -->
{getCurrencyOption(code).symbol}
