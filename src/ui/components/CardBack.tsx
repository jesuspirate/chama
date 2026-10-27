import { useT } from '../../i18n/index.js';
import { BackButton } from './BackButton.js';

/** A card's way back: the shared Back button, labelled "Back". */
export function CardBack({ onClick, disabled = false }: { onClick: () => void; disabled?: boolean }) {
  const { t } = useT();
  return <BackButton onClick={onClick} disabled={disabled} label={t("lts.back")} />;
}
