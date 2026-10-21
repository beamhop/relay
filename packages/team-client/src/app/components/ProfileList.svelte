<script lang="ts">
  import Button from "@lib/components/Button.svelte"
  import ModalFooter from "@lib/components/ModalFooter.svelte"
  import Modal from "@lib/components/Modal.svelte"
  import ModalBody from "@lib/components/ModalBody.svelte"
  import ModalHeader from "@lib/components/ModalHeader.svelte"
  import ModalTitle from "@lib/components/ModalTitle.svelte"
  import ModalSubtitle from "@lib/components/ModalSubtitle.svelte"
  import Profile from "@app/components/Profile.svelte"

  type Props = {
    title: string
    pubkeys: string[]
    subtitle?: string
    url?: string
  }

  const {title, subtitle = "", pubkeys, url}: Props = $props()

  const back = () => history.back()
</script>

<Modal>
  <ModalBody>
    <ModalHeader>
      <ModalTitle>{title}</ModalTitle>
      <ModalSubtitle>{subtitle}</ModalSubtitle>
    </ModalHeader>
    {#each pubkeys as pubkey (pubkey)}
      <div class="card">
        <Profile {pubkey} {url} />
      </div>
    {/each}
  </ModalBody>
  <ModalFooter>
    <Button class="button button-primary" onclick={back}>Got it</Button>
  </ModalFooter>
</Modal>
