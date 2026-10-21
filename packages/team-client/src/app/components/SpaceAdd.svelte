<script lang="ts">
  import Login from "@assets/icons/login-3.svg?dataurl"
  import Icon from "@lib/components/Icon.svelte"
  import Button from "@lib/components/Button.svelte"
  import CardButton from "@lib/components/CardButton.svelte"
  import Modal from "@lib/components/Modal.svelte"
  import ModalBody from "@lib/components/ModalBody.svelte"
  import ModalHeader from "@lib/components/ModalHeader.svelte"
  import ModalTitle from "@lib/components/ModalTitle.svelte"
  import ModalSubtitle from "@lib/components/ModalSubtitle.svelte"
  import SpaceInviteAccept from "@app/components/SpaceInviteAccept.svelte"
  import {pushModal} from "@app/ui/modal"

  const startJoin = () => pushModal(SpaceInviteAccept)
</script>

<Modal>
  <ModalBody>
    <ModalHeader>
      <ModalTitle>Add a Space</ModalTitle>
      <ModalSubtitle
        >Spaces are places where communities come together to work, play, and hang out.</ModalSubtitle>
    </ModalHeader>
    <Button onclick={startJoin}>
      <CardButton primary>
        {#snippet icon()}
          <div><Icon icon={Login} size={7} /></div>
        {/snippet}
        {#snippet title()}
          <div>Join a space</div>
        {/snippet}
        {#snippet info()}
          <div>Enter an invite link to join an existing space.</div>
        {/snippet}
      </CardButton>
    </Button>
    <!-- beamhop: no-payments (space creation was the paid-hosting plan picker) -->
  </ModalBody>
</Modal>
