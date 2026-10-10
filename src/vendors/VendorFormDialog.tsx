import { useMutation } from "convex/react";
import { FormEvent, useState } from "react";
import { api } from "../../convex/_generated/api";
import { getErrorMessage } from "../lib/errors";
import { Button, Dialog, focusFirstInvalid, useToast } from "../ui";
import { EMPTY_VENDOR_FORM, VendorFormFields, serverVendorError, vendorFormArgs, type VendorFormErrors, type VendorFormState } from "./VendorFormFields";

export type EditableVendor = {
  _id: string;
  name: string;
  trades: string[];
  contactName: string;
  email: string;
  phone: string;
  licenseNumber: string;
  licenseState: string;
};

/** Add vendor (no `vendor`) or Edit vendor. */
export function VendorFormDialog({ open, vendor, onClose }: { open: boolean; vendor: EditableVendor | null; onClose: () => void }) {
  if (!open) return null;
  return <VendorFormDialogBody key={vendor?._id ?? "new"} vendor={vendor} onClose={onClose} />;
}

function VendorFormDialogBody({ vendor, onClose }: { vendor: EditableVendor | null; onClose: () => void }) {
  const create = useMutation(api.vendors.createVendor);
  const update = useMutation(api.vendors.updateVendor);
  const toast = useToast();
  const [form, setForm] = useState<VendorFormState>(() =>
    vendor
      ? {
          name: vendor.name,
          trades: vendor.trades.join(", "),
          contactName: vendor.contactName,
          email: vendor.email,
          phone: vendor.phone,
          licenseNumber: vendor.licenseNumber,
          licenseState: vendor.licenseState,
        }
      : EMPTY_VENDOR_FORM,
  );
  const [errors, setErrors] = useState<VendorFormErrors>({});
  const [saving, setSaving] = useState(false);
  const formId = vendor ? "vendor-edit-form" : "vendor-add-form";

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const parsed = vendorFormArgs(form);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      focusFirstInvalid(event.currentTarget);
      return;
    }
    setErrors({});
    setSaving(true);
    try {
      if (vendor) await update({ vendorId: vendor._id, ...parsed.args });
      else await create(parsed.args);
      toast.success(vendor ? `${parsed.args.name} updated.` : `${parsed.args.name} added to your vendors.`);
      onClose();
    } catch (err) {
      setErrors(serverVendorError(err, getErrorMessage(err, "We couldn't save the vendor. Try again.")));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      title={vendor ? `Edit ${vendor.name}` : "Add vendor"}
      onClose={onClose}
      footer={
        <>
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form={formId} loading={saving} loadingLabel="Saving…">
            {vendor ? "Save changes" : "Add vendor"}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={onSubmit} noValidate aria-label={vendor ? "Edit vendor" : "Add vendor"}>
        <VendorFormFields idPrefix="vendor" form={form} errors={errors} onChange={setForm} />
      </form>
    </Dialog>
  );
}
